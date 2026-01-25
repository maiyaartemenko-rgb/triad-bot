// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve(process.cwd(), "data/access.json");

// Гарантируем, что файл есть
function safeLoad() {
  try {
    const txt = fs.readFileSync(FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { users: {} }; // { users: { [contactId]: { plan, paid_until, daily_used, day } } }
  }
}

function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}

export function getAccess(contactId) {
  const db = safeLoad();
  return db.users[contactId] || null;
}

export function setAccess(contactId, data) {
  const db = safeLoad();
  db.users[contactId] = { ...(db.users[contactId] || {}), ...data };
  safeSave(db);
  return db.users[contactId];
}

// Ежедневный лимит: basic = 3, unlimited = Infinity, trial = 3/день, 3 дня
function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function isTrialActive(rec) {
  if (!rec?.trial_started_at) return false;
  const started = new Date(rec.trial_started_at).getTime();
  const diffDays = Math.floor((Date.now() - started) / 86400000);
  return diffDays < 3; // 3 дня
}

function planDailyLimit(rec) {
  if (!rec) return 0;
  if (rec.plan === "unlimited") return Infinity;
  if (rec.plan === "basic") return 3;
  if (isTrialActive(rec)) return 3;
  return 0;
}

export function ensureUserRecord(contactId) {
  const rec = getAccess(contactId);
  if (rec) return rec;
  // создаём триал при первом обращении
  return setAccess(contactId, {
    plan: null,
    trial_started_at: new Date().toISOString(),
    daily_used: 0,
    day: todayStr(),
  });
}

export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // сбросить счётчик, если новый день
  if (rec.day !== dayNow) {
    rec.day = dayNow;
    rec.daily_used = 0;
  }

  const limit = planDailyLimit(rec);
  if (limit === Infinity) {
    setAccess(contactId, rec);
    return { ok: true, left: Infinity, plan: rec.plan || "trial" };
  }

  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);
    return { ok: true, left: limit - rec.daily_used, plan: rec.plan || (isTrialActive(rec) ? "trial" : null) };
  }

  return { ok: false, left: 0, plan: rec.plan || (isTrialActive(rec) ? "trial" : null) };
}