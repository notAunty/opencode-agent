import { test } from "node:test"
import assert from "node:assert/strict"
import { errorFields, trace } from "../src/diagnostics.js"

test("diagnostics retain safe error categories without payloads, tokens or identifiers", () => {
  const lines: string[] = []; const original = console.error
  console.error = line => { lines.push(String(line)) }
  try {
    trace("slack.received", "private-event-id")
    trace("chat.routing.failed", "private-event-id", errorFields({ name: "Error", message: "secret prompt", stack: "secret stack", data: { error: "missing_scope", token: "secret token" } }))
    trace("chat.routing.failed", "private-event-id", errorFields({ name: "secret", code: "secret", status: 429 }))
  } finally { console.error = original }
  assert.doesNotMatch(lines.join("\n"), /private-event-id|secret/)
  assert.equal(JSON.parse(lines[0]!).ref, JSON.parse(lines[1]!).ref)
  assert.equal(JSON.parse(lines[1]!).code, "missing_scope")
  assert.equal(JSON.parse(lines[2]!).status, 429)
})
