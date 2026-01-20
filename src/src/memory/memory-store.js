// src/memory/memory-store.js

const MAX_TURNS = 10; // "turn" = одно сообщение (user или assistant)
const store = new Map(); // key: contactId -> array of messages

export function getHistory(contactId) {
  const arr = store.get(String(contactId)) || [];
  return arr;
}

export function pushToHistory(contactId, role, content) {
  const key = String(contactId);
  const arr = store.get(key) || [];

  arr.push({
    role, // "user" | "assistant" | "system"
    content: String(content || ""),
    ts: Date.now()
  });

  // оставляем только последние MAX_TURNS * 2 (чтобы был запас)
  const trimmed = arr.slice(-MAX_TURNS);

  store.set(key, trimmed);
  return trimmed;
}

export function clearHistory(contactId) {
  store.delete(String(contactId));
}
