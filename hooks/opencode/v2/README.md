# RTK OpenCode V2 plugin (native, output-only)

Native Promise plugin (`Plugin.define`, id `rtk`) that prunes shell
tool output. Original commands are never rewritten.

## Target

- Load path: `file:///home/james/Documents/rtk-fork/hooks/opencode/v2`.
- Dependency only: `@opencode/plugin` `2.0.32` (matches the live server; no core import).
- Requires `rtk` in `PATH`. Missing binary preserves the original output.
- No host launches or restarts.

## Design

- Hook only `tool.execute.after`, shell tools with completed `exit 0`.
- Spawn only `rtk pipe [-f <filter>]`, with captured output on stdin, never in shell syntax.
- Adopt filtered output only if nonblank and strictly smaller in UTF-8 bytes; else keep original.
- Bound filtering to two seconds and 4 MiB; `RTK_DISABLED=1` disables it.
- Preserve tool input, status/exit, metadata, and notices unchanged.
- Explicit `rtk` (incl. `proxy`) bypasses filtering; never double-filter.
- Failures, running states, and background completions pass through
  (background final notification is not captured).
- Unsupported output and complex shell expressions pass through conservatively.
- Known filters: simple `git status/log/diff`, `cargo test`, `pytest`,
  `tsc`, `vitest`, `find`/`fd`, `rg`/`grep`; otherwise `rtk pipe` auto-detects.

## Manual use

- Direct `rtk` stays supported (`bun`/`dart`/`flutter` retained fork).
- Raw retry only after a failed default attempt and only when safe:
  `rtk proxy <command> [args...]`, or whole expression
  `rtk proxy bash -c '...'`. In RTK 1.0.1, `proxy` is a compatible alias of
  `bypass`; neither filters output. No automatic rerun.

## Why output-only

Command-rewriting hooks run before native shell permissions. Filtering
completed output instead avoids wrapper permission laundering and permission
parser duplication entirely, while preserving the original command's execution.

## Verification

- `bun test` (26 tests) and `bun run typecheck` in this directory.
- Limitation: `rtk pipe` does not currently track stats (raw `proxy` still does).
