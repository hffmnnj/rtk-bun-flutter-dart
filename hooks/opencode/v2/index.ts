import { Plugin } from "@opencode/plugin";
import { compressOutput } from "./compress.ts";
import { minifyJson } from "./json.ts";

// Native OpenCode V2 RTK plugin — output pruning ONLY.
//
// Safety boundary (by construction, not by convention):
// - ONLY `tool.execute.after` is registered; inputs and permissions untouched.
// - Shell output shrinks via `compressOutput` (only `rtk pipe` spawns);
//   complex shell compacts JSON locally, never via autodetect.
// - `execute` (CodeMode) minifies complete JSON text locally, no subprocess,
//   never running the code; truncated results pass through.
// - Adoption needs a verbatim content match plus strictly smaller UTF-8;
//   metadata, exit/signal, notices, and structured outputs are preserved.
type ShellInput = {
  readonly command?: unknown;
  readonly workdir?: unknown;
  readonly background?: unknown;
};

type CodeInput = {
  readonly code?: unknown;
};

type TextEntry = { readonly type: "text"; readonly text: string };

function isTextEntry(value: unknown): value is TextEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { readonly type?: unknown; readonly text?: unknown };
  return entry.type === "text" && typeof entry.text === "string";
}

const RAW_CODE_HINT = /\brtk\b/i;

function isTruncatedResult(result: {
  readonly metadata?: unknown;
}): boolean {
  const metadata = result.metadata;
  if (metadata === null || typeof metadata !== "object" || metadata === undefined) return false;
  return (metadata as { readonly truncated?: unknown }).truncated === true;
}

export default Plugin.define({
  id: "rtk",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.status !== "completed") return;
        if (event.tool === "shell") {
          const input = (event.input ?? {}) as ShellInput;
          if (typeof input.command !== "string" || !input.command) return;
          // Foreground results only; background executions stream separately.
          if (input.background === true) return;
          const body = event.result.output as
            | { readonly output?: unknown; readonly exit?: unknown; readonly status?: unknown }
            | undefined;
          if (typeof body?.output !== "string" || !body.output) return;
          // Only successful, settled executions. Anything else (non-zero exit,
          // still-running background shells) passes through untouched.
          if (body.status === "running" || body.exit !== 0) return;
          const raw: string = body.output;
          const cwd = typeof input.workdir === "string" && input.workdir ? input.workdir : process.cwd();
          const filtered = await compressOutput(input.command, raw, cwd);
          if (filtered === raw) return;
          const content = event.result.content;
          if (typeof content === "string") {
            if (content !== raw) return;
            event.result = { ...event.result, output: { ...body, output: filtered }, content: filtered };
            return;
          }
          if (Array.isArray(content)) {
            if (!content.some((entry) => isTextEntry(entry) && entry.text === raw)) return;
            event.result = {
              ...event.result,
              output: { ...body, output: filtered },
              content: content.map((entry) =>
                isTextEntry(entry) && entry.text === raw ? { ...entry, text: filtered } : entry,
              ),
            };
          }
          // Any other content shape (including undefined, which the native shell
          // tool never produces) means the result is not in the expected layout:
          // leave it untouched rather than risk an inconsistent result.
          return;
        }
        if (event.tool === "execute") {
          const input = (event.input ?? {}) as CodeInput;
          if (typeof input.code !== "string") return;
          if (process.env.RTK_DISABLED === "1") return;
          if (RAW_CODE_HINT.test(input.code)) return;
          const result = event.result;
          if (!result || typeof result !== "object") return;
          if (isTruncatedResult(result)) return;
          const content = result.content;
          if (typeof content === "string") {
            if (!content) return;
            const compact = minifyJson(content);
            if (compact === content) return;
            if (typeof result.output === "string" && result.output === content) {
              event.result = { ...result, output: compact, content: compact };
            } else {
              event.result = { ...result, content: compact };
            }
            return;
          }
          if (Array.isArray(content)) {
            let changed = false;
            const next = content.map((entry) => {
              if (!isTextEntry(entry) || !entry.text) return entry;
              const compact = minifyJson(entry.text);
              if (compact === entry.text) return entry;
              changed = true;
              return { ...entry, text: compact };
            });
            if (!changed) return;
            const out: unknown = result.output;
            if (typeof out === "string") {
              for (let i = 0; i < content.length; i++) {
                const orig = content[i];
                if (isTextEntry(orig) && orig.text === out) {
                  const updated = next[i];
                  if (isTextEntry(updated) && updated.text !== out) {
                    event.result = { ...result, output: updated.text, content: next };
                    return;
                  }
                  break;
                }
              }
            }
            event.result = { ...result, content: next };
            return;
          }
          return;
        }
        return;
      } catch {
        // This hook must never break a completed tool result; on any
        // unexpected error the original output stands.
      }
    });
  },
});
