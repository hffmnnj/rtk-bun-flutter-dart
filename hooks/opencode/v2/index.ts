import { Plugin } from "@opencode/plugin";
import { compressOutput } from "./compress.ts";

// Native OpenCode V2 RTK plugin — output pruning ONLY.
//
// Safety boundary (by construction, not by convention):
// - The ONLY hook registered is `tool.execute.after`, and it handles ONLY the
//   `shell` tool with `status: "completed"` foreground results. It NEVER
//   mutates commands or tool inputs, NEVER registers a shell hook, and NEVER
//   touches permissions. Native permission evaluation and command execution
//   are therefore exactly as without this plugin; the worst case is output
//   that passes through unpruned.
// - The ONLY subprocess ever spawned is `rtk pipe` (via `compressOutput`),
//   fed the already-captured output on stdin. The original command is never
//   re-executed.
// - Adoption is conservative: the filtered text replaces the result body only
//   when the filter exits 0 with non-empty output strictly shorter than the
//   original, AND the same body text is found verbatim in `result.content`
//   (first text entry per the native shell tool layout, notices separate).
//   Anything else — failures, background/running results, non-zero exits,
//   explicit `rtk`/`rtk proxy` commands, complex shell syntax, missing content
//   match — leaves the result untouched. All replacements use spread copies;
//   metadata, exit/signal/shellID, and notices keep their identity.
type ShellInput = {
  readonly command?: unknown;
  readonly workdir?: unknown;
  readonly background?: unknown;
};

type TextEntry = { readonly type: "text"; readonly text: string };

function isTextEntry(value: unknown): value is TextEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { readonly type?: unknown; readonly text?: unknown };
  return entry.type === "text" && typeof entry.text === "string";
}

export default Plugin.define({
  id: "rtk",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event.tool !== "shell" || event.status !== "completed") return;
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
      } catch {
        // This hook must never break a completed tool result; on any
        // unexpected error the original output stands.
      }
    });
  },
});
