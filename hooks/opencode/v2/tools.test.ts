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
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { registerCodeModeTools } from "./tools"

// Hermetic contract tests for registerCodeModeTools(ctx).
//
// The tool under test is captured through a small fake ctx.tool.transform
// (the promise-surface API from @opencode/plugin), following local Bun test
// patterns. The fake `rtk` below is the oracle: a POSIX shell script, so any
// execution of the tested command hint would actually run (the marker probe
// catches it). Raw output always travels via stdin (never argv), and the
// real `rtk` binary is never consulted.

const PRETTY = '{\n  "name": "rtk",\n  "count": 3,\n  "tags": ["a", "b"]\n}'
const COMPACT = '{"name":"rtk","count":3,"tags":["a","b"]}'
const LONG_OUTPUT = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8"
const SHRUNK = "SHORT"
const GIT_STATUS = "git status"

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

type CapturedTool = {
  readonly name: string
  readonly options?: unknown
  readonly input?: unknown
  readonly output?: unknown
  readonly execute: (input: any, context: any) => Promise<any>
}

let dir = ""
let fakeRtk = ""
let callLog = ""
let stdinCapture = ""
let marker = ""
let savedPath: string | undefined
let namespaces: Array<{ readonly name: string }> = []
let added: CapturedTool[] = []

// Every fake invocation appends one `argc|arg1|...|arg4|pwd` line, so the log
// proves argv shape (pipe first, no raw output in argv), call count (no retry
// on failure, no spawn on bypass), and the subprocess cwd. Stdin is saved to
// FAKE_STDIN so the success tests prove the raw text arrived intact.
const FAKE = `#!/bin/sh
if [ -n "$FAKE_CALL_LOG" ]; then
  printf '%s|%s|%s|%s|%s|%s\\n' "$#" "$1" "$2" "$3" "$4" "$(pwd)" >> "$FAKE_CALL_LOG"
fi
if [ "$1" != "pipe" ]; then exit 2; fi
if [ -n "$FAKE_STDIN" ]; then
  cat > "$FAKE_STDIN"
fi
case "$FAKE_MODE" in
  shrink) printf '${SHRUNK}'; exit 0;;
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

function toolContext(): any {
  return {
    sessionID: "ses_test1234567890abcdef",
    agent: "agent_testbuild",
    messageID: "msg_test1234567890",
    id: "call_test1234567890",
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

async function registerTools(): Promise<void> {
  namespaces = []
  added = []
  const editor: any = {
    namespace: (ns: { readonly name: string }) => {
      namespaces.push(ns)
    },
    add: (tool: CapturedTool) => {
      added.push(tool)
    },
    list: () => added,
    get: (id: string) => added.find((tool) => tool.name === id),
    update: () => undefined,
    remove: () => undefined,
  }
  const ctx: any = {
    // The tool resolves its subprocess cwd from the plugin context
    // location, never from caller input; the fixture points it at this
    // plugin directory so the call log proves where the filter ran.
    location: { directory: PLUGIN_DIR },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback(editor)
        return { dispose: async () => {} }
      },
    },
  }
  await registerCodeModeTools(ctx)
}

function requireTool(): CapturedTool {
  const tool = added.find((entry) => entry.name === "compress")
  if (!tool) throw new Error("rtk/compress tool was not registered")
  return tool
}

beforeAll(async () => {
  const parent = "/var/tmp/james/opencode"
  mkdirSync(parent, { recursive: true })
  dir = mkdtempSync(join(parent, "tools-test-"))
  fakeRtk = join(dir, "rtk")
  callLog = join(dir, "calls.log")
  stdinCapture = join(dir, "stdin.bin")
  marker = join(dir, "marker")
  writeFileSync(fakeRtk, FAKE, { mode: 0o755 })
  chmodSync(fakeRtk, 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`
  process.env.FAKE_CALL_LOG = callLog
  process.env.FAKE_STDIN = stdinCapture
  await registerTools()
})

afterAll(() => {
  delete process.env.FAKE_CALL_LOG
  delete process.env.FAKE_STDIN
  delete process.env.FAKE_MODE
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  // Individual files only; never a recursive remove.
  for (const file of [callLog, stdinCapture, marker, fakeRtk]) {
    if (existsSync(file)) unlinkSync(file)
  }
  if (dir && existsSync(dir)) rmdirSync(dir)
})

test("codemode_tool_registers_rtk_compress_with_codemode_options", () => {
  expect(namespaces.map((ns) => ns.name)).toEqual(["rtk"])
  expect(added.map((tool) => tool.name)).toEqual(["compress"])
  const tool = requireTool()
  expect(tool.options).toEqual({ namespace: "rtk", codemode: true })
  expect(tool.input).toBeDefined()
  expect(tool.output).toBeDefined()
  expect(typeof tool.execute).toBe("function")
})

test("codemode_compress_minifies_json_and_reports_byte_counts", async () => {
  process.env.FAKE_MODE = "shrink"
  clearCalls()
  const tool = requireTool()
  const input = { text: PRETTY }
  const snapshot = JSON.parse(JSON.stringify(input))
  const result = await tool.execute(input, toolContext())
  const inputBytes = Buffer.byteLength(PRETTY)
  const outputBytes = Buffer.byteLength(COMPACT)
  expect(result.output).toEqual({
    text: COMPACT,
    inputBytes,
    outputBytes,
    savedBytes: inputBytes - outputBytes,
  })
  expect(result.content).toBe(COMPACT)
  // Caller input is never mutated, and plain JSON compacts with no subprocess.
  expect(input).toEqual(snapshot)
  expect(readCalls()).toEqual([])
})

test("codemode_compress_preserves_number_and_string_lexemes", async () => {
  process.env.FAKE_MODE = "shrink"
  clearCalls()
  const tool = requireTool()
  const pretty =
    '{\n  "big": 9007199254740993,\n  "negZero": -0,\n  "exp": 1.2300e+45,\n  "msg": "a  b",\n  "q": "a\\"b",\n  "uni": "\\u0041",\n  "z": 1,\n  "a": 1,\n  "a": 2\n}'
  const compact =
    '{"big":9007199254740993,"negZero":-0,"exp":1.2300e+45,"msg":"a  b","q":"a\\"b","uni":"\\u0041","z":1,"a":1,"a":2}'
  const result = await tool.execute({ text: pretty }, toolContext())
  expect(result.output.text).toBe(compact)
  expect(result.content).toBe(compact)
  expect(JSON.parse(result.output.text)).toEqual(JSON.parse(pretty))
  // Shrink mode would compact via pipe if one ran; the byte-exact result
  // plus zero calls proves local lossless minify did the work.
  expect(readCalls()).toEqual([])
})

test("codemode_command_hint_compresses_only_on_success_exit", async () => {
  const tool = requireTool()
  // Success: the pipe filter runs (proves hint-gated filtering works).
  process.env.FAKE_MODE = "shrink"
  clearCalls()
  const okInput = { text: LONG_OUTPUT, command: GIT_STATUS, exitCode: 0 }
  const okSnapshot = JSON.parse(JSON.stringify(okInput))
  const ok = await tool.execute(okInput, toolContext())
  expect(ok.output.text).toBe(SHRUNK)
  expect(ok.output.savedBytes).toBe(Buffer.byteLength(LONG_OUTPUT) - Buffer.byteLength(SHRUNK))
  expect(ok.content).toBe(SHRUNK)
  expect(okInput).toEqual(okSnapshot)
  expect(readFileSync(stdinCapture, "utf8")).toBe(LONG_OUTPUT)
  const calls = readCalls()
  expect(calls).toHaveLength(1)
  expect(calls[0].split("|")[1]).toBe("pipe")
  expect(calls[0]).not.toContain("line1")
  // The subprocess runs in the plugin location, never a caller directory.
  expect(calls[0].split("|").at(-1)).toBe(PLUGIN_DIR)
  // Failure and unknown status preserve text exactly without spawning.
  process.env.FAKE_MODE = "destructive"
  clearCalls()
  const failed = await tool.execute({ text: LONG_OUTPUT, command: GIT_STATUS, exitCode: 1 }, toolContext())
  expect(failed.output.text).toBe(LONG_OUTPUT)
  expect(failed.output.savedBytes).toBe(0)
  expect(failed.content).toBe(LONG_OUTPUT)
  expect(readCalls()).toEqual([])
  process.env.FAKE_MODE = "shrink"
  clearCalls()
  const unknown = await tool.execute({ text: LONG_OUTPUT, command: GIT_STATUS }, toolContext())
  expect(unknown.output.text).toBe(LONG_OUTPUT)
  expect(unknown.output.savedBytes).toBe(0)
  expect(unknown.content).toBe(LONG_OUTPUT)
  expect(readCalls()).toEqual([])
})

test("codemode_disabled_and_explicit_rtk_bypass_without_spawn", async () => {
  const tool = requireTool()
  process.env.FAKE_MODE = "shrink"
  clearCalls()
  const savedDisabled = process.env.RTK_DISABLED
  process.env.RTK_DISABLED = "1"
  try {
    // Shrink mode would return SHRUNK if the filter ran, so the verbatim
    // text plus zero calls proves the RTK_DISABLED=1 override is honored.
    const disabled = await tool.execute({ text: PRETTY, command: GIT_STATUS, exitCode: 0 }, toolContext())
    expect(disabled.output.text).toBe(PRETTY)
    expect(disabled.output.savedBytes).toBe(0)
    expect(disabled.content).toBe(PRETTY)
    expect(readCalls()).toEqual([])
  } finally {
    if (savedDisabled === undefined) delete process.env.RTK_DISABLED
    else process.env.RTK_DISABLED = savedDisabled
  }
  // Explicit rtk bypasses even though the fake would compress anything.
  process.env.FAKE_MODE = "destructive"
  clearCalls()
  const explicit = await tool.execute(
    { text: PRETTY, command: "rtk proxy git status", exitCode: 0 },
    toolContext(),
  )
  expect(explicit.output.text).toBe(PRETTY)
  expect(explicit.content).toBe(PRETTY)
  expect(readCalls()).toEqual([])
})

test("codemode_command_hint_is_never_executed", async () => {
  process.env.FAKE_MODE = "shrink"
  clearCalls()
  if (existsSync(marker)) unlinkSync(marker)
  const tool = requireTool()
  const command = `touch "${marker}"`
  const result = await tool.execute({ text: LONG_OUTPUT, command, exitCode: 0 }, toolContext())
  // Positive compression proves the filter ran on stdin; the missing marker
  // proves the hint string itself was never executed (a no-op implementation
  // returning the input would fail the SHRUNK assertion).
  expect(result.output.text).toBe(SHRUNK)
  expect(result.content).toBe(SHRUNK)
  expect(readFileSync(stdinCapture, "utf8")).toBe(LONG_OUTPUT)
  expect(readCalls()).toHaveLength(1)
  expect(existsSync(marker)).toBe(false)
})
