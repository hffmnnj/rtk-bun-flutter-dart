import { spawn } from "node:child_process";
import { minifyJson } from "./json.ts";

// Budget for the `rtk pipe` subprocess. The compressor only filters text piped
// on stdin — it never spawns the original command — so a small budget keeps
// tool-result latency bounded. Anything over budget fails open (output passes
// through unfiltered).
const PIPE_TIMEOUT_MS = 2000;
const PIPE_MAX_BUFFER = 4 * 1024 * 1024; // 4 MiB

// Conservative raw intent: explicit `rtk` tokens (quoted/relative/env forms)
// always pass through verbatim, even when the output is JSON.
const EXPLICIT_RTK = /(?:^|[\s/'"])rtk(?:[\s'"]|$)/;

// Complex shell syntax (multiline, pipelines, chains, background,
// redirections, subshells, substitution) never consults `rtk pipe`; JSON
// output still compacts locally via minifyJson, everything else passes.
const COMPLEX_SHELL = /[\n\r|&;><()`$]/;

/** True when the command explicitly asks for raw RTK output. */
function isExplicitRtk(command: string): boolean {
  return EXPLICIT_RTK.test(command);
}

/** True when the command is too complex for a prefix-selected filter. */
function isComplexShell(command: string): boolean {
  return COMPLEX_SHELL.test(command);
}

type Filter = { args: string[] };

/**
 * Selects an explicit `rtk pipe -f <filter>` from simple known command
 * prefixes. Matching is deliberately narrow — leading whitespace, then an
 * exact command word (or `git`/`cargo`/`bun` + exact subcommand) at a word
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
  m = /^(bun)\s+test(?:\s|$)/.exec(text);
  if (m) return { args: ["-f", "bun-test"] };
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
 * Compresses captured shell output via `rtk pipe` plus local JSON minify.
 *
 * Disabled/oversize/explicit-`rtk` pass through first. Complex shell returns
 * the local JSON minify (original when not JSON). Simple commands run
 * `rtk pipe`; on exit 0 the strictly smaller UTF-8 of the valid pipe result
 * and the JSON minify wins, otherwise the original stands. Pipe failures
 * keep the original even when JSON could compact. Only `rtk pipe` runs.
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
  if (!command || isExplicitRtk(command)) return output;
  const jsonCandidate = minifyJson(output);
  if (isComplexShell(command)) return jsonCandidate;
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
      const filteredBytes = Buffer.byteLength(filtered);
      const rtkValid = filtered.trim() !== "" && filteredBytes < inputBytes;
      const jsonBytes = Buffer.byteLength(jsonCandidate);
      const jsonValid =
        jsonCandidate !== output && jsonCandidate.trim() !== "" && jsonBytes < inputBytes;
      let best = output;
      let bestBytes = inputBytes;
      if (rtkValid) {
        best = filtered;
        bestBytes = filteredBytes;
      }
      if (jsonValid && jsonBytes < bestBytes) {
        best = jsonCandidate;
        bestBytes = jsonBytes;
      }
      done(best);
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
