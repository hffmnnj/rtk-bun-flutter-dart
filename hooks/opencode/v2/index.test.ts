import { afterAll, beforeAll, expect, test } from "bun:test"
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

// Hermetic contract tests for the FINAL rtk output-compression plugin.
//
// Contract (promise style, no Effect, no permission gating):
// - `Plugin.define({ id: "rtk", setup })` registers ONE hook only:
//   `tool` / `execute.after`. No `shell` hooks, no `execute.before`,
//   no permission hooks. Permission behavior stays native because inputs
//   are never mutated and nothing runs before the tool.
// - The `execute.after` callback only acts on `tool === "shell"` with
//   `status === "completed"` and `result.output.status === "completed"`
//   (`exit: 0`). It compresses the ALREADY-CAPTURED output via
//   `compressOutput(command, raw, cwd, env)` (`./compress.ts`), which pipes
//   `raw` on stdin to `rtk` (execFile, no shell).
// - Valid compressed output replaces `result.output.output` and ONLY the
//   content text entry EXACTLY equal to `raw`. Everything else is preserved:
//   `exit`/`signal`/`status`, `metadata`, notices/other content entries,
//   and the `input` object (the native command stays byte-for-byte original).
// - Skipped (result untouched, `rtk` never spawned): nonzero exit, `running`
//   status, tool `error` status, non-shell tools, explicit `rtk …`
//   (including `rtk proxy …`), complex shell expressions, and any `rtk`
//   failure (nonzero exit) or missing binary.
//
// The fake `rtk` below is the oracle: a POSIX shell script that compresses
// ANYTHING piped to it (prints a short constant). Therefore zero calls
// proves a bypass happened before spawning, and one call with stdin === raw
// proves the pipe contract. A real command execution would create the
// marker file, which must stay absent.

const COMPRESSED = "COMPRESSED-OUTPUT"
const RAW = "M src/discover/registry.rs\nM src/main.rs\n?? new-capability.md\n"
const NOTICE = "Output was truncated at 10000 bytes; showing the first 10000 bytes."
const COMMAND = "git status"

let dir = ""
let fakeRtk = ""
let callLog = ""
let stdinFile = ""
let marker = ""
let emptyPathDir = ""
let savedPath: string | undefined
let callback: ((event: any) => Promise<unknown>) | undefined

// Each fake invocation appends an `argv:` line plus a `pwd` line, so the log
// proves call count (exactly one pipe call, no retry) and the cwd the
// subprocess ran in. Stdin is captured to $FAKE_RTK_STDIN for byte equality.
const FAKE = `#!/bin/sh
if [ -n "$FAKE_RTK_CALL_LOG" ]; then
  { printf 'argv:'; printf ' <%s>' "$@"; printf '\\n'; pwd; } >> "$FAKE_RTK_CALL_LOG"
fi
if [ -n "$FAKE_RTK_STDIN" ]; then cat > "$FAKE_RTK_STDIN"; else cat > /dev/null; fi
if [ "$FAKE_RTK_FAIL" = "1" ]; then exit 3; fi
printf '${COMPRESSED}'
exit 0
`

function readCalls(): string[] {
  if (!existsSync(callLog)) return []
  return readFileSync(callLog, "utf8").split("\n").filter(Boolean)
}

function clearCalls(): void {
  for (const file of [callLog, stdinFile]) {
    if (existsSync(file)) unlinkSync(file)
  }
}

function readStdin(): string | undefined {
  if (!existsSync(stdinFile)) return undefined
  return readFileSync(stdinFile, "utf8")
}

function completedShellEvent(command: string, raw: string, extra?: Record<string, unknown>) {
  return {
    tool: "shell",
    sessionID: "ses_test1234567890abcdef",
    agent: "agent_testbuild",
    messageID: "msg_test1234567890",
    id: "call_test1234567890",
    input: { command, workdir: dir },
    status: "completed",
    result: {
      output: { output: raw, exit: 0, status: "completed", truncated: false },
      content: [{ type: "text", text: raw }],
      metadata: { status: "completed", kept: "yes" },
    },
    ...extra,
  } as any
}

beforeAll(async () => {
  const parent = "/var/tmp/james/opencode"
  mkdirSync(parent, { recursive: true })
  dir = mkdtempSync(join(parent, "index-test-"))
  fakeRtk = join(dir, "rtk")
  callLog = join(dir, "calls.log")
  stdinFile = join(dir, "stdin.bin")
  marker = join(dir, "marker")
  emptyPathDir = join(dir, "empty-path")
  mkdirSync(emptyPathDir)
  writeFileSync(fakeRtk, FAKE, { mode: 0o755 })
  chmodSync(fakeRtk, 0o755)

  savedPath = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`
  process.env.FAKE_RTK_CALL_LOG = callLog
  process.env.FAKE_RTK_STDIN = stdinFile

  const mod: any = await import("./index")
  const plugin: any = mod?.default ?? mod
  expect(plugin?.id).toBe("rtk")
  expect(typeof plugin?.setup).toBe("function")

  // Deliberately NO session object: fixtures always carry input.workdir,
  // so the plugin must never need session.get(...).location.directory.
  const toolHooks: Array<{ name: string; cb: (event: any) => Promise<unknown> }> = []
  const shellHooks: string[] = []
  const permissionHooks: string[] = []
  const fakeCtx: any = {
    tool: {
      hook: (name: string, cb: (event: any) => Promise<unknown>) => {
        toolHooks.push({ name, cb })
        return Promise.resolve({ dispose: async () => {} })
      },
    },
    shell: {
      hook: (name: string, _cb: (event: any) => Promise<unknown>) => {
        shellHooks.push(name)
        return Promise.resolve({ dispose: async () => {} })
      },
    },
    permission: {
      hook: (name: string, _cb: (event: any) => Promise<unknown>) => {
        permissionHooks.push(name)
        return Promise.resolve({ dispose: async () => {} })
      },
    },
  }
  await plugin.setup(fakeCtx)
  expect(toolHooks.map((h) => h.name)).toEqual(["execute.after"])
  expect(shellHooks).toEqual([])
  expect(permissionHooks).toEqual([])
  expect(typeof toolHooks[0]?.cb).toBe("function")
  callback = toolHooks[0]!.cb
})

afterAll(() => {
  delete process.env.FAKE_RTK_CALL_LOG
  delete process.env.FAKE_RTK_STDIN
  delete process.env.FAKE_RTK_FAIL
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  // Individual files only; never a recursive remove.
  for (const file of [callLog, stdinFile, marker, fakeRtk]) {
    if (existsSync(file)) unlinkSync(file)
  }
  if (existsSync(emptyPathDir)) rmdirSync(emptyPathDir)
  if (dir && existsSync(dir)) rmdirSync(dir)
})

function requireCallback(): (event: any) => Promise<unknown> {
  if (!callback) throw new Error("plugin callback not registered")
  return callback
}

test("plugin_registers_only_tool_execute_after_hook", async () => {
  // Registration is asserted in beforeAll (it must hold before any behavior
  // test runs); this test keeps the guarantee visible per-behavior.
  requireCallback()
})

test("completed_shell_output_is_compressed_command_byte_identical", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent(COMMAND, RAW)
  const inputBefore = JSON.parse(JSON.stringify(event.input))
  await cb(event)
  // Native command untouched byte-for-byte; only the captured output shrinks.
  expect(event.input).toEqual(inputBefore)
  expect(event.input.command).toBe(COMMAND)
  expect(event.result.output.output).toBe(COMPRESSED)
  expect(event.result.content).toEqual([{ type: "text", text: COMPRESSED }])
  // Metadata and exit/status preserved.
  expect(event.result.output.exit).toBe(0)
  expect(event.result.output.status).toBe("completed")
  expect(event.result.metadata).toEqual({ status: "completed", kept: "yes" })
  // Exactly one pipe call (no retry), stdin carried the raw output.
  expect(readCalls().length).toBe(2) // argv line + pwd line
  expect(readStdin()).toBe(RAW)
})

test("compression_replaces_only_matching_text_preserves_rest", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent(COMMAND, RAW)
  event.result.content = [
    { type: "text", text: RAW },
    { type: "text", text: NOTICE },
  ]
  event.result.output.signal = undefined
  await cb(event)
  expect(event.result.output.output).toBe(COMPRESSED)
  expect(event.result.content).toEqual([
    { type: "text", text: COMPRESSED },
    { type: "text", text: NOTICE },
  ])
  expect(readCalls().length).toBe(2)
})

test("compression_runs_in_input_workdir_without_session", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent(COMMAND, RAW)
  await cb(event)
  const lines = readCalls()
  expect(lines.length).toBe(2)
  expect(lines[1]).toBe(dir)
})

test("eligible_command_is_never_executed_and_rtk_called_once", async () => {
  const cb = requireCallback()
  clearCalls()
  if (existsSync(marker)) unlinkSync(marker)
  // Simple (non-complex) command: eligible for compression, but the plugin
  // must only pipe the captured output — never run this string.
  const event = completedShellEvent(`touch ${marker}`, "")
  event.result.output.output = RAW
  event.result.content = [{ type: "text", text: RAW }]
  await cb(event)
  expect(event.result.output.output).toBe(COMPRESSED)
  expect(existsSync(marker)).toBe(false)
  expect(readCalls().length).toBe(2)
})

test("nonzero_exit_leaves_result_untouched_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent(COMMAND, RAW)
  event.result.output.exit = 1
  const before = JSON.parse(JSON.stringify(event))
  await cb(event)
  expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  expect(readCalls()).toEqual([])
  expect(readStdin()).toBeUndefined()
})

test("running_output_leaves_result_untouched_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent(COMMAND, RAW)
  event.result.output.status = "running"
  delete event.result.output.exit
  const before = JSON.parse(JSON.stringify(event))
  await cb(event)
  expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  expect(readCalls()).toEqual([])
})

test("error_status_leaves_event_untouched_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = {
    tool: "shell",
    sessionID: "ses_test1234567890abcdef",
    agent: "agent_testbuild",
    messageID: "msg_test1234567890",
    id: "call_test1234567890",
    input: { command: COMMAND, workdir: dir },
    status: "error",
    error: { message: "boom" },
  } as any
  const before = JSON.parse(JSON.stringify(event))
  await cb(event)
  expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  expect(readCalls()).toEqual([])
})

test("non_shell_tool_leaves_result_untouched_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = {
    tool: "read",
    sessionID: "ses_test1234567890abcdef",
    agent: "agent_testbuild",
    messageID: "msg_test1234567890",
    id: "call_test1234567890",
    input: { path: "notes.txt" },
    status: "completed",
    result: {
      output: "file contents here",
      content: [{ type: "text", text: "file contents here" }],
      metadata: {},
    },
  } as any
  const before = JSON.parse(JSON.stringify(event))
  await cb(event)
  expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  expect(readCalls()).toEqual([])
})

test("explicit_rtk_commands_bypass_even_though_fake_would_compress", async () => {
  const cb = requireCallback()
  // The fake compresses anything it receives, so zero calls proves the
  // bypass happens before spawning — raw proxy output is never filtered.
  for (const command of ["rtk proxy bash -c 'echo hi'", "rtk status"]) {
    clearCalls()
    const event = completedShellEvent(command, RAW)
    const before = JSON.parse(JSON.stringify(event))
    await cb(event)
    expect(JSON.parse(JSON.stringify(event))).toEqual(before)
    expect(readCalls()).toEqual([])
  }
})

test("complex_shell_expression_bypasses_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent("git log --oneline | head -5", RAW)
  const before = JSON.parse(JSON.stringify(event))
  await cb(event)
  expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  expect(readCalls()).toEqual([])
})

test("failing_rtk_passthrough_preserves_original_output", async () => {
  const cb = requireCallback()
  clearCalls()
  process.env.FAKE_RTK_FAIL = "1"
  try {
    const event = completedShellEvent(COMMAND, RAW)
    const before = JSON.parse(JSON.stringify(event))
    await cb(event)
    // A failed filter must not filter: original output flows through.
    expect(JSON.parse(JSON.stringify(event))).toEqual(before)
    expect(readCalls().length).toBe(2)
  } finally {
    delete process.env.FAKE_RTK_FAIL
  }
})

test("missing_rtk_binary_preserves_original_output", async () => {
  const cb = requireCallback()
  clearCalls()
  const saved = process.env.PATH
  process.env.PATH = emptyPathDir
  try {
    const event = completedShellEvent(COMMAND, RAW)
    const before = JSON.parse(JSON.stringify(event))
    await cb(event)
    expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

const CODE = "const rows = await queryAll()"
const PRETTY_JSON = '{\n  "name": "rtk",\n  "count": 3,\n  "tags": ["a", "b"]\n}'
const COMPACT_JSON = '{"name":"rtk","count":3,"tags":["a","b"]}'

function completedExecuteEvent(code: string, content: unknown, output: unknown, metadata: Record<string, unknown> = { status: "completed", kept: "yes" }) {
  return {
    tool: "execute",
    sessionID: "ses_test1234567890abcdef",
    agent: "agent_testbuild",
    messageID: "msg_test1234567890",
    id: "call_test1234567890",
    input: { code },
    status: "completed",
    result: { output, content, metadata },
  } as any
}

test("shell_complex_json_output_compacts_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedShellEvent("git log --oneline | head -5", PRETTY_JSON)
  await cb(event)
  expect(event.result.output.output).toBe(COMPACT_JSON)
  expect(event.result.content).toEqual([{ type: "text", text: COMPACT_JSON }])
  expect(readCalls()).toEqual([])
})

test("codemode_array_json_minifies_preserving_rest_without_subprocess", async () => {
  const cb = requireCallback()
  clearCalls()
  const output = { rows: [{ a: 1 }] }
  const event = completedExecuteEvent(
    CODE,
    [
      { type: "text", text: PRETTY_JSON },
      { type: "text", text: NOTICE },
      { type: "file", uri: "file:///tmp/a.png", mime: "image/png" },
    ],
    output,
  )
  const inputBefore = JSON.parse(JSON.stringify(event.input))
  await cb(event)
  expect(event.result.content).toEqual([
    { type: "text", text: COMPACT_JSON },
    { type: "text", text: NOTICE },
    { type: "file", uri: "file:///tmp/a.png", mime: "image/png" },
  ])
  expect(event.result.output).toEqual(output)
  expect(event.result.metadata).toEqual({ status: "completed", kept: "yes" })
  expect(event.input).toEqual(inputBefore)
  expect(readCalls()).toEqual([])
  expect(readStdin()).toBeUndefined()
})

test("codemode_string_json_syncs_matching_output_string_only", async () => {
  const cb = requireCallback()
  clearCalls()
  const matched = completedExecuteEvent(CODE, PRETTY_JSON, PRETTY_JSON)
  await cb(matched)
  expect(matched.result.content).toBe(COMPACT_JSON)
  expect(matched.result.output).toBe(COMPACT_JSON)
  expect(matched.input).toEqual({ code: CODE })
  clearCalls()
  const structured = completedExecuteEvent(CODE, PRETTY_JSON, { count: 3 })
  await cb(structured)
  expect(structured.result.content).toBe(COMPACT_JSON)
  expect(structured.result.output).toEqual({ count: 3 })
  expect(readCalls()).toEqual([])
})

test("codemode_array_output_string_syncs_to_matching_entry", async () => {
  const cb = requireCallback()
  clearCalls()
  const matched = completedExecuteEvent(
    CODE,
    [
      { type: "text", text: PRETTY_JSON },
      { type: "text", text: NOTICE },
    ],
    PRETTY_JSON,
  )
  await cb(matched)
  expect(matched.result.output).toBe(COMPACT_JSON)
  expect(matched.result.content).toEqual([
    { type: "text", text: COMPACT_JSON },
    { type: "text", text: NOTICE },
  ])
  clearCalls()
  const unmatched = completedExecuteEvent(
    CODE,
    [
      { type: "text", text: PRETTY_JSON },
      { type: "text", text: NOTICE },
    ],
    "unrelated log",
  )
  await cb(unmatched)
  expect(unmatched.result.output).toBe("unrelated log")
  expect(unmatched.result.content).toEqual([
    { type: "text", text: COMPACT_JSON },
    { type: "text", text: NOTICE },
  ])
  expect(readCalls()).toEqual([])
})

test("codemode_truncated_metadata_passes_through_unchanged", async () => {
  const cb = requireCallback()
  clearCalls()
  const event = completedExecuteEvent(
    CODE,
    [
      { type: "text", text: PRETTY_JSON },
      { type: "text", text: NOTICE },
    ],
    PRETTY_JSON,
    { status: "completed", truncated: true },
  )
  const before = JSON.parse(JSON.stringify(event))
  await cb(event)
  expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  expect(readCalls()).toEqual([])
})

test("codemode_raw_code_disabled_and_malformed_pass_through", async () => {
  const cb = requireCallback()
  clearCalls()
  const rawCode = completedExecuteEvent("await shell('rtk status')", PRETTY_JSON, PRETTY_JSON)
  const rawBefore = JSON.parse(JSON.stringify(rawCode))
  await cb(rawCode)
  expect(JSON.parse(JSON.stringify(rawCode))).toEqual(rawBefore)
  const savedDisabled = process.env.RTK_DISABLED
  process.env.RTK_DISABLED = "1"
  try {
    clearCalls()
    const disabled = completedExecuteEvent(CODE, PRETTY_JSON, PRETTY_JSON)
    const disabledBefore = JSON.parse(JSON.stringify(disabled))
    await cb(disabled)
    expect(JSON.parse(JSON.stringify(disabled))).toEqual(disabledBefore)
  } finally {
    if (savedDisabled === undefined) delete process.env.RTK_DISABLED
    else process.env.RTK_DISABLED = savedDisabled
  }
  for (const bad of ["not json at all", '{"a": 1,', "42", "INFO starting\n{\"a\": 1}"]) {
    clearCalls()
    const event = completedExecuteEvent(CODE, bad, bad)
    const before = JSON.parse(JSON.stringify(event))
    await cb(event)
    expect(JSON.parse(JSON.stringify(event))).toEqual(before)
  }
  expect(readCalls()).toEqual([])
})

test("codemode_other_tools_ignore_json_content", async () => {
  const cb = requireCallback()
  for (const tool of ["read", "grep", "glob", "skill", "subagent"]) {
    clearCalls()
    const event = {
      tool,
      sessionID: "ses_test1234567890abcdef",
      agent: "agent_testbuild",
      messageID: "msg_test1234567890",
      id: "call_test1234567890",
      input: { path: "notes.txt" },
      status: "completed",
      result: {
        output: PRETTY_JSON,
        content: [{ type: "text", text: PRETTY_JSON }],
        metadata: {},
      },
    } as any
    const before = JSON.parse(JSON.stringify(event))
    await cb(event)
    expect(JSON.parse(JSON.stringify(event))).toEqual(before)
    expect(readCalls()).toEqual([])
  }
})
