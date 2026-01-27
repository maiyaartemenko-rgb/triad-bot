// src/access/tg-map-store.js
import fs from "node:fs";
import path from "node:path";

const FILE = fs.existsSync("/data")
  ? "/data/tg-map.json"
  : path.resolve(process.cwd(), "data/tg-map.json");

function safeLoad() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { map: {} }; // { map: { [telegram_user_id]: contactId } }
  }
}

function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}

export function setTgMap(telegramUserId, contactId) {
  if (!telegramUserId || !contactId) return;
  const db = safeLoad();
  db.map[String(telegramUserId)] = String(contactId);
  safeSave(db);
}

export function getContactIdByTgId(telegramUserId) {
  if (!telegramUserId) return null;
  const db = safeLoad();
  return db.map[String(telegramUserId)] || null;
}
