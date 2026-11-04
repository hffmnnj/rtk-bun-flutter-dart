# RTK OpenCode V2 plugin (native, output-only)

Native Promise plugin (`Plugin.define`, id `rtk`) that prunes shell output
and losslessly compacts complete CodeMode JSON results. Original commands are never rewritten.

## Target

- Load path: `file:///home/james/Documents/rtk-fork/hooks/opencode/v2`.
- Dependency only: `@opencode/plugin` `2.0.32` (no core import). The pin does
  not necessarily match the live server (2.2.1 at last check); only the
  promise-surface API used here is relied on.
- Command-specific pipe filters require `rtk` in `PATH`; a missing binary
  preserves their original output. Local JSON compaction needs no subprocess.
- Install/upgrade: point the loader at this path, keep the pinned
  dependency and `rtk` on `PATH`. No host launches or restarts.

## Design

- Hook only `tool.execute.after`: shell tools with completed `exit 0`, plus
  a narrow CodeMode `execute` JSON exception. No other tools touched.
- Spawn only `rtk pipe [-f <filter>]`, with captured output on stdin, never in shell syntax.
- Adopt filtered output only if nonblank and strictly smaller in UTF-8 bytes; else keep original.
  Simple commands keep the existing pipe flow; direct simple `bun test`
  selects `rtk pipe -f bun-test`, otherwise `rtk pipe` auto-detects.
  On a successful pipe the
  smaller of the filtered vs JSON-minified candidate wins; pipe failure
  keeps the original raw.
- Bound filtering to two seconds and 4 MiB; `RTK_DISABLED=1` disables it.
  Raw-`rtk`, disabled, and over-cap guards are unchanged.
- Preserve tool input, status/exit, metadata, and notices unchanged.
- Explicit `rtk` (incl. `proxy`) bypasses filtering; never double-filter.
- Failures, running states, and background completions pass through
  (background final notification is not captured).
- Known filters: simple `git status/log/diff`, `cargo test`, `pytest`,
  `tsc`, `vitest`, `find`/`fd`, `rg`/`grep`, and direct simple `bun test`
  (`rtk pipe -f bun-test`); otherwise `rtk pipe` auto-detects.
- `bun-test` applies only to a direct simple `bun test` single success
  report: every non-`(pass)` original byte line is preserved in order,
  with one banner, one `N pass` / `0 fail` summary pair, count-matched
  `(pass)` lines, and an intact `Ran N tests across M files` footer.
  Complex wrappers (`bun run`, chained/compound shell), multi-report,
  footer-mismatched, or any failure output stays raw. No generic
  autodetect broadening for complex commands.
- Complex shell expressions stay raw, except one lossless exception: a
  complete JSON object/array body is whitespace-minified (mixed logs stay
  raw). No blanket generic autodetect for complex commands.
- CodeMode `execute` stays untouched, except one narrow exception: an exact
  complete, nontruncated JSON object/array text body is whitespace-minified. The code
  itself is never executed or read as a source file; structured
  output objects and embedded string diagnostics are unchanged; code
  containing the word `rtk` skips (raw intent); `read`/`grep`/`glob`/`skill`
  and others are untouched.

## Lossless JSON minify (`json.ts`)

- `minifyJson(text)` validates the whole body as one complete JSON
  object/array (`<=4 MiB` via `JSON.parse`, result discarded), then removes
  only ASCII whitespace outside strings. Never reserializes.
- Format-only: every number lexeme, string escape, key, and key order is
  preserved byte-for-byte (e.g. `9007199254740993` stays exact, unlike
  `JSON.stringify` which would round it, normalize `-0`/`1.2300e+45`,
  escapes, duplicate keys, or order).
- Scalars, partial/trailing/mixed content pass through unchanged.

## Manual use

- Direct `rtk` stays supported (`bun`/`dart`/`flutter` retained fork).
- Raw retry only after a failed default attempt and only when safe:
  `rtk proxy <command> [args...]`, or whole expression
  `rtk proxy bash -c '...'`. In RTK 1.0.1, `proxy` is a compatible alias of
  `bypass`; neither filters output. No automatic rerun.

## Explicit CodeMode tool (`rtk.compress`)

Automatic `execute.after` compaction already handles CodeMode JSON results;
scripts must keep the original data for further computation and call this
tool only for the final displayed text. Do not paste huge captured output
into generated tool input: compute first, then pass only the final string
to compact.

- Inside Code Mode, call `tools.rtk.compress({ text, command, exitCode: 0 })`
  on the final text. Code Mode receives
  `{ text, inputBytes, outputBytes, savedBytes }`; use the compacted `text`
  as the final displayed value. Example: run the query,
  keep the rows for filtering and aggregation, then compact last:

  ```ts
  const rows = await queryAll()
  const total = rows.reduce((sum, row) => sum + row.amount, 0)
  const text = JSON.stringify({ total, rows }, null, 2)
  const compact = await tools.rtk.compress({ text })
  return compact.text
  ```

  The original `rows` stay intact for the math above; only the returned
  display string is compacted.

- Without `command`, complete JSON objects/arrays are whitespace-minified
  locally (the same lossless `minifyJson`; number and string lexemes
  preserved). With a nonempty `command` plus `exitCode: 0`, the same
  `rtk pipe` hint filtering applies as for shell output.
- `command` is only a filter hint: it is never executed. A failed
  (`exitCode !== 0`) or command-hinted unknown (missing `exitCode`) result
  stays raw, exactly as captured. No generic automatic MCP pruning is introduced: only
  this explicit call compacts, alongside the existing automatic
  `execute.after` JSON exception.
- `RTK_DISABLED=1` preserves text verbatim. As with automatic pipe
  filtering, `rtk gain` does not currently track these savings; the tool's
  own `inputBytes`/`outputBytes`/`savedBytes` fields report the single call.

## Why output-only

Command-rewriting hooks run before native shell permissions. Filtering
completed output instead avoids wrapper permission laundering and permission
parser duplication entirely, while preserving the original command's execution.

## Verification

- Run `bun test` and `bun run typecheck` in this directory.
- Limitation: `rtk pipe` does not currently track stats (raw `proxy` still does).
- Private audit corpus/data/results (e.g. `tools.jsonl`,
  `comparison.json` under `/var/tmp/james/opencode/`) are never committed.

## Audit note (aggregates only)

- Coverage: 5485 sessions (5478 complete, 3 partial, 4 unreadable),
  307626 tool records, 70759 shell calls, Aug 30-Oct 19.
- Actual old/new helper comparison improved 13,299 retained eligible JSON
  results: 49,915,343 → 45,005,524 bytes, an additional 4,909,819 bytes (9.84%
  of affected output). All significant JSON lexemes were verified unchanged;
  zero byte regressions occurred. No historical command was executed.
- Actual compiled `rtk pipe -f bun-test` on 200 captured Bun outputs:
  80 compacted, 120 unchanged, 766,549 bytes saved; every non-passing line
  verified byte-identical and in order, zero byte expansion or filter errors.
  Only 38 sampled commands meet the plugin's direct-simple boundary: all 38
  compacted, saving 302,653 bytes. The other 42 filter-accepted captures are
  not automatically admitted by the plugin. Wrapped/compound calls stay raw.
  This corrects an earlier prototype's overbroad 61-command attribution.
- These are offline measured output-byte savings, not billed token or future
  production savings. Mixed logs, source-file reads, failures, and raw bypass
  were not broadened to pursue larger but less certain estimates.
