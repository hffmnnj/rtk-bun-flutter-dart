import { expect, test } from "bun:test"
import { minifyJson } from "./json"

// Contract tests for minifyJson(text): whitespace-only minification for
// complete JSON objects/arrays. Byte-exact hand-written expectations are
// the oracle (they reject a JSON.stringify reserialize, which normalizes
// large integers, -0, exponent lexemes, escapes, duplicate keys, and key
// order); JSON.stringify is used as an oracle only for generated fixtures
// built from plain values that survive reserialization.

test("minify_pretty_object_strips_outside_whitespace", () => {
  const input = '{\n  "name": "rtk",\n  "count": 3,\n  "ok": true,\n  "nothing": null\n}'
  expect(minifyJson(input)).toBe('{"name":"rtk","count":3,"ok":true,"nothing":null}')
})

test("minify_nested_arrays_and_objects", () => {
  const input =
    '{\n  "users": [\n    {\n      "id": 1,\n      "tags": ["a", "b"]\n    },\n    {\n      "id": 2,\n      "tags": []\n    }\n  ],\n  "total": 2\n}'
  expect(minifyJson(input)).toBe('{"users":[{"id":1,"tags":["a","b"]},{"id":2,"tags":[]}],"total":2}')
})

test("minify_pretty_array_strips_outside_whitespace", () => {
  expect(minifyJson('[\n  1,\n  2,\n  3\n]')).toBe('[1,2,3]')
})

test("minify_large_integer_lexeme_preserved_byte_exact", () => {
  expect(minifyJson('{\n  "big": 9007199254740993\n}')).toBe('{"big":9007199254740993}')
})

test("minify_negative_zero_preserved_byte_exact", () => {
  expect(minifyJson('{\n  "v": -0\n}')).toBe('{"v":-0}')
})

test("minify_exponent_lexeme_preserved_byte_exact", () => {
  expect(minifyJson('{\n  "e": 1.2300e+45\n}')).toBe('{"e":1.2300e+45}')
})

test("minify_duplicate_keys_preserved_in_order", () => {
  expect(minifyJson('{\n  "a": 1,\n  "a": 2\n}')).toBe('{"a":1,"a":2}')
})

test("minify_key_order_preserved", () => {
  expect(minifyJson('{\n  "z": 1,\n  "a": 2,\n  "m": 3\n}')).toBe('{"z":1,"a":2,"m":3}')
})

test("minify_escaped_quotes_and_backslashes_preserved", () => {
  const input = '{\n  "q": "a\\"b",\n  "bs": "c\\\\d",\n  "tail": "end\\\\"\n}'
  expect(minifyJson(input)).toBe('{"q":"a\\"b","bs":"c\\\\d","tail":"end\\\\"}')
})

test("minify_unicode_escape_and_literal_unicode_preserved", () => {
  const input = '{\n  "esc": "\\u0041",\n  "lit": "héllo 🧪"\n}'
  expect(minifyJson(input)).toBe('{"esc":"\\u0041","lit":"héllo 🧪"}')
})

test("minify_literal_unicode_line_separators_inside_strings_are_data", () => {
  const input = '{\n  "text": "before\u2028middle\u2029after"\n}'
  expect(minifyJson(input)).toBe('{"text":"before\u2028middle\u2029after"}')
})

test("minify_whitespace_inside_strings_preserved", () => {
  const input = '{\n  "msg": "a  b   c",\n  "pad": " x "\n}'
  expect(minifyJson(input)).toBe('{"msg":"a  b   c","pad":" x "}')
})

test("minify_invalid_partial_and_non_json_returns_original", () => {
  const inputs = [
    "",
    '{"a": 1,',
    '{"a": 1',
    "[1, 2,",
    "not json at all",
    "INFO starting\n{\"a\": 1}",
    '{"a":1} trailing',
    '{"a":1}\n{"b":2}',
    "   \n\t  ",
    "42",
    '"str"',
    "true",
    "null",
  ]
  for (const input of inputs) {
    expect(minifyJson(input)).toBe(input)
  }
})

test("minify_compact_input_is_idempotent", () => {
  const compact = '{"a":[1,2,{"b":null}],"c":"x y"}'
  expect(minifyJson(compact)).toBe(compact)
  const pretty = '{\n  "a": [1, 2, { "b": null }],\n  "c": "x y"\n}'
  expect(minifyJson(minifyJson(pretty))).toBe(minifyJson(pretty))
})

test("minify_generated_nested_fixtures_match_stringify_oracle", () => {
  // JSON.stringify is the independent oracle here ONLY: every fixture uses
  // plain values (small ints, simple strings, unique keys) that survive a
  // parse/stringify round-trip unchanged.
  const fixtures: unknown[] = [
    { a: 1 },
    { name: "alpha", tags: ["x y", "beta"], count: 7, ok: true, missing: null },
    [1, 2, 3],
    { nested: { list: [{ x: 1 }, { y: [true, false, null] }], empty: {} } },
    { deep: [[["a"]], { b: [[2]] }] },
    [],
    {},
  ]
  for (const value of fixtures) {
    const pretty = JSON.stringify(value, null, 2)
    const compact = JSON.stringify(value)
    expect(minifyJson(pretty)).toBe(compact)
    expect(minifyJson(compact)).toBe(compact)
    expect(JSON.parse(minifyJson(pretty))).toEqual(value)
  }
})

test("minify_oversize_valid_json_returns_original", () => {
  const big = `{"data": "${"x".repeat(4 * 1024 * 1024)}"}`
  expect(Buffer.byteLength(big) > 4 * 1024 * 1024).toBe(true)
  expect(minifyJson(big)).toBe(big)
})
