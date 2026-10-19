import { expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { delimiter, join } from "node:path"
import { compressOutput } from "./compress"

// Hermetic contract tests for compressOutput(command, output, cwd, env).
//
// The fake `rtk` below is the oracle: a POSIX shell script, so any shell
// interpretation of the tested command would actually execute (the marker
// probe catches that). It answers only `pipe` with canned responses driven
// by FAKE_MODE; the raw output always travels via stdin (never argv), and
// the real `rtk` binary is never consulted. Callers pass overrides through
// the explicit `env` parameter; process.env is never mutated.

// Distinct commands keep each behavior's oracle independent.
const GIT_STATUS = "git status"
const CARGO_TEST = "cargo test"
const PYTEST = "pytest"
const TSC = "tsc --noEmit"
const LONG_OUTPUT = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8"
const SHRUNK = "short"
const FAIL_STDOUT = "rtk MUST-BE-IGNORED"
const EXPLICIT_PROXY = "rtk proxy git status"
const EXPLICIT_ABS = "/usr/local/bin/rtk pipe git status"
const PIPED = "git status | head -n 5"

let dir = ""
let fakeRtk = ""
let callLog = ""
let stdinCapture = ""
let marker = ""
let emptyPathDir = ""
let testEnv: NodeJS.ProcessEnv = {}

// Every fake invocation appends one `argc|arg1|arg2|arg3|arg4` line, so the
// log also proves exact argv shape (pipe first, no raw output in argv) and
// call count (no retry on failure, no subprocess on bypass). Stdin is saved
// to FAKE_STDIN so the success test proves the raw output arrived intact.
const FAKE = `#!/bin/sh
if [ -n "$FAKE_CALL_LOG" ]; then
  printf '%s|%s|%s|%s|%s\\n' "$#" "$1" "$2" "$3" "$4" >> "$FAKE_CALL_LOG"
fi
if [ "$1" != "pipe" ]; then exit 2; fi
if [ -n "$FAKE_STDIN" ]; then
  cat > "$FAKE_STDIN"
fi
case "$FAKE_MODE" in
  shrink) printf '${SHRUNK}'; exit 0;;
  custom) printf '%s' "$FAKE_OUTPUT"; exit 0;;
  empty) exit 0;;
  larger) printf 'this filtered output is deliberately much longer than the tiny input'; exit 0;;
  fail) printf '${FAIL_STDOUT}'; exit 1;;
  destructive) printf 'rm -rf / -- fake destructive output, must never surface'; exit 0;;
  *) exit 1;;
esac
`

function readCalls(): string[] {
  if (!existsSync(callLog)) return []
  return readFileSync(callLog, "utf8").split("\n").filter(Boolean)
}

function clearCalls(): void {
  if (existsSync(callLog)) unlinkSync(callLog)
  if (existsSync(stdinCapture)) unlinkSync(stdinCapture)
}

function makeEnv(mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...testEnv, FAKE_MODE: mode, ...extra }
}

import { afterAll, beforeAll } from "bun:test"

beforeAll(() => {
  const parent = "/var/tmp/james/opencode"
  mkdirSync(parent, { recursive: true })
  dir = mkdtempSync(join(parent, "compress-test-"))
  fakeRtk = join(dir, "rtk")
  callLog = join(dir, "calls.log")
  stdinCapture = join(dir, "stdin.bin")
  marker = join(dir, "marker")
  emptyPathDir = join(dir, "empty-path")
  mkdirSync(emptyPathDir)
  writeFileSync(fakeRtk, FAKE, { mode: 0o755 })
  chmodSync(fakeRtk, 0o755)
  testEnv = {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_CALL_LOG: callLog,
    FAKE_STDIN: stdinCapture,
  }
})

afterAll(() => {
  // Individual files only; never a recursive remove.
  for (const file of [callLog, stdinCapture, marker, fakeRtk]) {
    if (existsSync(file)) unlinkSync(file)
  }
  if (existsSync(emptyPathDir)) rmdirSync(emptyPathDir)
  if (dir && existsSync(dir)) rmdirSync(dir)
})

test("compress_shrinks_output_and_pipes_raw_output_via_stdin", async () => {
  clearCalls()
  const result = await compressOutput(GIT_STATUS, LONG_OUTPUT, dir, makeEnv("shrink"))
  expect(result).toBe(SHRUNK)
  // Raw output must arrive on stdin byte-identical, never in argv.
  expect(readFileSync(stdinCapture, "utf8")).toBe(LONG_OUTPUT)
  const calls = readCalls()
  expect(calls).toHaveLength(1)
  expect(calls[0].split("|")[1]).toBe("pipe")
  expect(calls[0]).not.toContain("line1")
})

test("compress_nonzero_exit_ignores_stdout_and_does_not_retry", async () => {
  clearCalls()
  const result = await compressOutput(CARGO_TEST, LONG_OUTPUT, dir, makeEnv("fail"))
  expect(result).toBe(LONG_OUTPUT)
  expect(readCalls()).toHaveLength(1)
})

test("compress_empty_filtered_output_leaves_output_unchanged", async () => {
  clearCalls()
  const result = await compressOutput(PYTEST, LONG_OUTPUT, dir, makeEnv("empty"))
  expect(result).toBe(LONG_OUTPUT)
})

test("compress_larger_filtered_output_leaves_output_unchanged", async () => {
  const result = await compressOutput(TSC, "tiny", dir, makeEnv("larger"))
  expect(result).toBe("tiny")
})

test("compress_explicit_rtk_and_proxy_bypass_subprocess_entirely", async () => {
  for (const command of [EXPLICIT_PROXY, EXPLICIT_ABS, "./rtk proxy git status", "'rtk' proxy git status", "env FOO=1 /usr/local/bin/rtk proxy git status", "FOO=1 rtk git log"]) {
    clearCalls()
    // Destructive mode proves the bypass: any spawn would surface its output.
    const result = await compressOutput(command, LONG_OUTPUT, dir, makeEnv("destructive"))
    expect(result).toBe(LONG_OUTPUT)
    expect(readCalls()).toEqual([])
  }
})

test("compress_complex_shell_syntax_bypasses_subprocess", async () => {
  clearCalls()
  const result = await compressOutput(PIPED, LONG_OUTPUT, dir, makeEnv("destructive"))
  expect(result).toBe(LONG_OUTPUT)
  expect(readCalls()).toEqual([])
})

test("compress_rejects_shorter_utf16_text_that_costs_more_utf8_bytes", async () => {
  const result = await compressOutput(GIT_STATUS, "abcdef", dir, makeEnv("custom", { FAKE_OUTPUT: "🧪🧪" }))
  expect(result).toBe("abcdef")
})

test("compress_whitespace_only_result_preserves_diagnostics", async () => {
  const result = await compressOutput(GIT_STATUS, LONG_OUTPUT, dir, makeEnv("custom", { FAKE_OUTPUT: "\n" }))
  expect(result).toBe(LONG_OUTPUT)
})

test("compress_oversize_input_bypasses_subprocess", async () => {
  clearCalls()
  const raw = "x".repeat(4 * 1024 * 1024 + 1)
  expect(await compressOutput(GIT_STATUS, raw, dir, makeEnv("shrink"))).toBe(raw)
  expect(readCalls()).toEqual([])
})

test("compress_missing_executable_leaves_output_unchanged", async () => {
  const envWithoutRtk: NodeJS.ProcessEnv = { ...process.env, PATH: emptyPathDir }
  const result = await compressOutput(GIT_STATUS, LONG_OUTPUT, dir, envWithoutRtk)
  expect(result).toBe(LONG_OUTPUT)
})

test("compress_embedded_touch_marker_is_never_executed", async () => {
  if (existsSync(marker)) unlinkSync(marker)
  const command = `git log --oneline; touch "${marker}"`
  const result = await compressOutput(command, LONG_OUTPUT, dir, makeEnv("shrink"))
  expect(result).toBe(LONG_OUTPUT)
  expect(existsSync(marker)).toBe(false)
})

test("compress_rtk_disabled_env_skips_without_spawning", async () => {
  clearCalls()
  // Shrink mode would return SHRUNK if the filter ran, so the original
  // output plus zero calls proves the RTK_DISABLED=1 override is honored.
  const result = await compressOutput(GIT_STATUS, LONG_OUTPUT, dir, makeEnv("shrink", { RTK_DISABLED: "1" }))
  expect(result).toBe(LONG_OUTPUT)
  expect(readCalls()).toEqual([])
})

test("compress_caller_env_overrides_are_used_without_mutating_input", async () => {
  clearCalls()
  const pathBefore = process.env.PATH
  const env = makeEnv("shrink")
  const snapshot = { ...env }
  const result = await compressOutput(GIT_STATUS, LONG_OUTPUT, dir, env)
  expect(result).toBe(SHRUNK)
  // The fake ran, so the PATH override carrying it was honored — while the
  // caller's env object and the real process environment are untouched.
  expect(readCalls()).toHaveLength(1)
  expect(env).toEqual(snapshot)
  expect(process.env.PATH).toBe(pathBefore)
  expect(process.env.RTK_DISABLED).toBe(snapshot.RTK_DISABLED)
})

test("compress_complex_json_compacts_locally_preserving_lexemes", async () => {
  clearCalls()
  const pretty =
    '{\n  "big": 9007199254740993,\n  "negZero": -0,\n  "exp": 1.2300e+45,\n  "msg": "a  b",\n  "q": "a\\"b",\n  "uni": "\\u0041"\n}'
  const compact =
    '{"big":9007199254740993,"negZero":-0,"exp":1.2300e+45,"msg":"a  b","q":"a\\"b","uni":"\\u0041"}'
  // Destructive mode proves no spawn: any `rtk pipe` call would surface it.
  const result = await compressOutput(PIPED, pretty, dir, makeEnv("destructive"))
  expect(result).toBe(compact)
  expect(JSON.parse(result)).toEqual(JSON.parse(pretty))
  expect(readCalls()).toEqual([])
})

test("compress_complex_plain_and_mixed_logs_bypass_without_spawn", async () => {
  const cases = [
    "line1\nline2\nline3",
    "INFO starting\n{\"a\": 1}",
    '{"a":1} trailing',
    '{"a":1}\n{"b":2}',
    '{"a": 1,',
  ]
  for (const output of cases) {
    clearCalls()
    // Shrink mode would return SHRUNK if a filter ran, so the original plus
    // zero calls proves complex output never consults `rtk pipe`.
    const result = await compressOutput("git log --oneline; echo done", output, dir, makeEnv("shrink"))
    expect(result).toBe(output)
    expect(readCalls()).toEqual([])
  }
})

test("compress_explicit_rtk_json_bypasses_verbatim_without_spawn", async () => {
  const pretty = '{\n  "a": 1,\n  "b": 2\n}'
  for (const command of [
    "rtk proxy git status",
    "rtk status",
    "/usr/local/bin/rtk pipe git status",
    "'rtk' proxy git status",
    "FOO=1 rtk git log",
  ]) {
    clearCalls()
    const result = await compressOutput(command, pretty, dir, makeEnv("shrink"))
    expect(result).toBe(pretty)
    expect(readCalls()).toEqual([])
  }
})

test("compress_simple_pipe_success_prefers_smallest_of_pipe_and_json", async () => {
  const pretty = '{\n  "name": "rtk",\n  "count": 3\n}'
  const minified = '{"name":"rtk","count":3}'
  // Pipe returns a valid but longer-than-minified result: local JSON wins.
  clearCalls()
  const jsonWins = await compressOutput(
    GIT_STATUS,
    pretty,
    dir,
    makeEnv("custom", { FAKE_OUTPUT: '{"name": "rtk", "count": 3}' }),
  )
  expect(jsonWins).toBe(minified)
  // Pipe returns the smallest result: pipe wins.
  clearCalls()
  const pipeWins = await compressOutput(GIT_STATUS, pretty, dir, makeEnv("shrink"))
  expect(pipeWins).toBe(SHRUNK)
})

test("compress_pipe_failure_preserves_original_json", async () => {
  const pretty = '{\n  "name": "rtk",\n  "count": 3\n}'
  clearCalls()
  expect(await compressOutput(GIT_STATUS, pretty, dir, makeEnv("fail"))).toBe(pretty)
  expect(readCalls()).toHaveLength(1)
  const envWithoutRtk: NodeJS.ProcessEnv = { ...process.env, PATH: emptyPathDir }
  expect(await compressOutput(GIT_STATUS, pretty, dir, envWithoutRtk)).toBe(pretty)
})

test("compress_bun_test_selects_bun_test_filter", async () => {
  for (const command of ["bun test", "bun test --coverage", "  bun test", "bun test tests/foo.test.ts"]) {
    clearCalls()
    const result = await compressOutput(command, LONG_OUTPUT, dir, makeEnv("shrink"))
    expect(result).toBe(SHRUNK)
    // Raw output must arrive on stdin byte-identical, never in argv.
    expect(readFileSync(stdinCapture, "utf8")).toBe(LONG_OUTPUT)
    const calls = readCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe("3|pipe|-f|bun-test|")
    expect(calls[0]).not.toContain("line1")
  }
})

test("compress_bun_lookalikes_fall_back_to_autodetect", async () => {
  for (const command of ["bun testx", "bun run test", "bun --cwd /tmp test"]) {
    clearCalls()
    const result = await compressOutput(command, LONG_OUTPUT, dir, makeEnv("shrink"))
    expect(result).toBe(SHRUNK)
    expect(readFileSync(stdinCapture, "utf8")).toBe(LONG_OUTPUT)
    // Generic autodetect: bare `pipe` with no `-f`, not `bun-test`.
    expect(readCalls()).toEqual(["1|pipe|||"])
  }
})

test("compress_complex_bun_commands_bypass_subprocess", async () => {
  for (const command of ["cd /tmp && bun test", "bun test | head -n 5"]) {
    clearCalls()
    // Destructive mode proves the bypass: any spawn would surface its output.
    const result = await compressOutput(command, LONG_OUTPUT, dir, makeEnv("destructive"))
    expect(result).toBe(LONG_OUTPUT)
    expect(readCalls()).toEqual([])
  }
  // Local JSON still compacts without consulting `rtk pipe`.
  const pretty = '{\n  "name": "rtk",\n  "count": 3\n}'
  for (const command of ["cd /tmp && bun test", "bun test | head -n 5"]) {
    clearCalls()
    const result = await compressOutput(command, pretty, dir, makeEnv("destructive"))
    expect(result).toBe('{"name":"rtk","count":3}')
    expect(readCalls()).toEqual([])
  }
})

test("compress_explicit_rtk_bun_test_bypasses_verbatim", async () => {
  const pretty = '{\n  "a": 1,\n  "b": 2\n}'
  for (const command of ["rtk proxy bun test", "rtk bypass bun test"]) {
    clearCalls()
    // Shrink mode would return SHRUNK if the filter ran, so the pretty
    // output plus zero calls proves the explicit-`rtk` bypass is honored.
    const result = await compressOutput(command, pretty, dir, makeEnv("shrink"))
    expect(result).toBe(pretty)
    expect(readCalls()).toEqual([])
  }
})
