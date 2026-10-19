import { spawn } from "node:child_process";

// Budget for the `rtk pipe` subprocess. The compressor only filters text piped
// on stdin — it never spawns the original command — so a small budget keeps
// tool-result latency bounded. Anything over budget fails open (output passes
// through unfiltered).
const PIPE_TIMEOUT_MS = 2000;
const PIPE_MAX_BUFFER = 4 * 1024 * 1024; // 4 MiB

// Conservatively skip any RTK token, including quoted/relative paths and env
// prefixes. False positives only forgo savings; missing a proxy would lose raw output.
const EXPLICIT_RTK = /(?:^|[\s/'"])rtk(?:[\s'"]|$)/;

// Conservative shell-syntax exclusions: multiline, pipelines, `&&`/`||`/`;` chains, background `&`,
// redirections, subshells, and command/variable substitution. Filter choice
// is prefix-based and only sound for simple single commands; anything complex
// falls back to unfiltered output rather than risk a mismatched filter
// mangling the text. Deliberately NOT excluded: quotes, env prefixes
// (`FOO=1 cmd`), globs — those fall through to generic autodetect, which the
// `rtk pipe` binary passes through unchanged when it cannot safely compress.
const COMPLEX_SHELL = /[\n\r|&;><()`$]/;

/** True when the command's output must pass through without consulting `rtk pipe`. */
function shouldBypass(command: string): boolean {
  return EXPLICIT_RTK.test(command) || COMPLEX_SHELL.test(command);
}

type Filter = { args: string[] };

/**
 * Selects an explicit `rtk pipe -f <filter>` from simple known command
 * prefixes. Matching is deliberately narrow — leading whitespace, then an
 * exact command word (or `git`/`cargo` + exact subcommand) at a word
 * boundary — so a mismatched filter can never mangle output it was not built
 * for. `git show` is excluded on purpose (blob output is unsafe to prune);
 * absolute-path invocations (`/usr/bin/git status`), env-prefixed commands,
 * and everything else fall through to generic autodetect (`rtk pipe` with no
 * `-f`, which the binary passes through unchanged when unsure).
 */
function selectFilter(command: string): Filter {
  const text = command.replace(/^\s+/, "");
  let m = /^(git)\s+(status|log|diff)(?:\s|$)/.exec(text);
  if (m) return { args: ["-f", `git-${m[2]}`] };
  m = /^(cargo)\s+test(?:\s|$)/.exec(text);
  if (m) return { args: ["-f", "cargo-test"] };
  m = /^(pytest|tsc|vitest|find|fd|rg|grep)(?:\s|$)/.exec(text);
  if (m) {
    const name = m[1] === "fd" ? "find" : m[1] === "rg" ? "grep" : m[1];
    return { args: ["-f", name] };
  }
  return { args: [] };
}

/**
 * Merges the given env over the plugin process env without mutating either.
 * Entries with `undefined` values are dropped so they cannot blank out
 * process keys (notably PATH, which is needed to locate `rtk`).
 */
function mergeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Compresses captured shell output via `rtk pipe`.
 *
 * Runs `rtk pipe [-f <filter>]` with the output fed on stdin and returns the
 * filtered text ONLY when the filter exits 0 with non-empty output strictly
 * shorter than the input. Every other outcome — bypass match, `RTK_DISABLED`,
 * spawn error, non-zero exit, timeout, over-size output, empty or
 * longer-or-equal result — returns the original output unchanged. The
 * original command is never spawned; only `rtk pipe` runs.
 */
export async function compressOutput(
  command: string,
  output: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.env.RTK_DISABLED === "1" || env.RTK_DISABLED === "1") return output;
  if (!output) return output;
  const inputBytes = Buffer.byteLength(output);
  if (inputBytes > PIPE_MAX_BUFFER) return output;
  if (!command || shouldBypass(command)) return output;
  const filter = selectFilter(command);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn("rtk", ["pipe", ...filter.args], {
        cwd,
        env: mergeEnv(env),
        timeout: PIPE_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return done(output);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.on("error", () => done(output));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PIPE_MAX_BUFFER) {
        child.kill();
        done(output);
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) return done(output);
      const filtered = Buffer.concat(chunks).toString("utf8");
      if (!filtered.trim() || Buffer.byteLength(filtered) >= inputBytes) return done(output);
      done(filtered);
    });
    // Swallow EPIPE when `rtk pipe` exits early (e.g. unknown filter);
    // `close` still fires and resolves with the original output.
    child.stdin.on("error", () => undefined);
    try {
      child.stdin.end(output);
    } catch {
      done(output);
    }
  });
}
