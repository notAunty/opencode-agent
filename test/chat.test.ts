import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Message, type Attachment, type Thread } from "chat"
import { ChatBridge, ChatRouter } from "../src/chat.js"
import { AgentSessions } from "../src/service.js"
import { Timers } from "../src/timers.js"
import { captureFile, uploadedFile } from "../src/transfers.js"
import type { Json, Sessions } from "../src/contracts.js"

function message(userId: string, text: string, attachments: Attachment[] = []): Message {
  return new Message({ id: `message-${userId}-${text}`, threadId: "telegram:conversation", text,
    formatted: { type: "root", children: [] }, raw: {}, attachments,
    author: { userId, userName: userId, fullName: userId, isBot: false, isMe: false },
    metadata: { dateSent: new Date(), edited: false } })
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octg-chat-"))
  let state: Json | undefined
  const prompts: unknown[] = []; const posts: unknown[] = []
  const sessions: Sessions = { create: async input => ({ id: input.id }), get: async id => ({ id }),
    prompt: async input => { prompts.push(input) }, context: async () => [], compact: async () => {}, interrupt: async () => {} }
  const service = new AgentSessions({ get: async () => structuredClone(state), set: async (_, value) => { state = structuredClone(value) } }, sessions, { post: async (_, text) => { posts.push(text) } })
  await service.create({ id: "alice", allowedUsers: ["telegram:1"] })
  const timers = new Timers(join(directory, ".octg", "timers.json"))
  const router = new ChatRouter(service, timers, directory)
  const thread: Pick<Thread, "id" | "post" | "subscribe"> = { id: "telegram:conversation", subscribe: async () => {}, post: async (value: unknown) => { posts.push(value); return {} as Awaited<ReturnType<Thread["post"]>> } }
  return { directory, service, timers, router, thread, prompts, posts }
}

test("Chat SDK messages require Agent Session authorization before downloading attachments", async () => {
  const f = await fixture()
  await f.router.handle(f.thread, message("1", "!agent alice"))
  let downloads = 0
  const attachment: Attachment = { type: "image", mimeType: "image/png", fetchData: async () => { downloads++; return Buffer.from("synthetic-image") } }
  await f.router.handle(f.thread, message("2", "unauthorized", [attachment]))
  assert.equal(downloads, 0); assert.equal(f.prompts.length, 0)
  await f.router.handle(f.thread, message("1", "caption", [attachment]))
  await f.service.tick(); assert.equal(downloads, 1); assert.equal(f.prompts.length, 1)
  assert.match(JSON.stringify(f.prompts), /file:\/\/.*uploads/)
  await f.router.handle(f.thread, message("2", "!wake 0 intruder"))
  assert.equal((await f.timers.list("alice")).length, 0)
  await f.router.handle(f.thread, message("1", "!wake 0 inspect task"))
  assert.equal((await f.timers.list("alice")).length, 1)
})
test("disabled Chat bridge neither needs credentials nor opens network connections", async () => {
  const bridge = new ChatBridge({ enabled: false, host: "127.0.0.1", port: 8787, platforms: ["telegram", "slack", "discord"], discordGateway: false })
  await bridge.start(); await assert.rejects(bridge.post("telegram:any", "hello"), /disabled/); await bridge.stop()
})
test("explicit file output captures an immutable project artifact and bounds disclosure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octg-output-"))
  const source = join(directory, "screenshot.png")
  await writeFile(source, "synthetic screenshot")
  const file = await captureFile(directory, "screenshot.png")
  await writeFile(source, "changed later")
  assert.equal((await uploadedFile(file)).data.toString(), "synthetic screenshot")
  const outside = await mkdtemp(join(tmpdir(), "octg-outside-"))
  await writeFile(join(outside, "private.txt"), "private")
  await assert.rejects(captureFile(directory, join(outside, "private.txt")), /within/)
  assert.equal(await readFile(source, "utf8"), "changed later")
  const unsafe = await mkdtemp(join(tmpdir(), "octg-symlink-"))
  await symlink(outside, join(unsafe, ".octg"))
  await writeFile(join(unsafe, "image.png"), "synthetic")
  await assert.rejects(captureFile(unsafe, "image.png"), /symlink/)
})
