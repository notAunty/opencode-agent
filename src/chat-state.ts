import { createMemoryState } from "@chat-adapter/state-memory"
import type { StateAdapter } from "chat"
import { json, type Storage } from "./contracts.js"

export function localChatState(storage?: Storage): StateAdapter {
  const state = createMemoryState()
  if (!storage) return state
  const get = state.get.bind(state)
  const set = state.set.bind(state)
  const remove = state.delete.bind(state)
  const persistent = (key: string) => key.startsWith("telegram:polling:")
  // Acknowledged failed updates and album parts must survive a restart.
  state.get = async <T>(key: string): Promise<T | null> => persistent(key)
    ? (await storage.get(`chat:${key}`) as T | null | undefined) ?? null : get<T>(key)
  state.set = async <T>(key: string, value: T, ttlMs?: number): Promise<void> => {
    if (persistent(key)) await storage.set(`chat:${key}`, json(value))
    else await set(key, value, ttlMs)
  }
  state.delete = async key => {
    if (persistent(key)) await storage.set(`chat:${key}`, null)
    else await remove(key)
  }
  return state
}
