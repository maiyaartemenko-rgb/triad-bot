// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/access.json");

// { users: { [contactId]: { plan, paid_until, trial_started_at, daily_used, day } } }

function safeLoad() {
  try {
    const txt = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") return { users: {} };
    if (!parsed.users || typeof parsed.users !== "object") parsed.users = {};
    return parsed;
  } catch {
    return { users: {} };
  }
}

function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}

export function getAccess(contactId) {
  if (!contactId) return null;
  const db = safeLoad();
  return db.users[String(contactId)] || null;
}

export function setAccess(contactId, data) {
  if (!contactId) return null;
  const id = String(contactId);
  const db = safeLoad();
  db.users[id] = { ...(db.users[id] || {}), ...(data || {}) };
  safeSave(db);
  return db.users[id];
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isPaidActive(rec) {
  if (!rec) return false;
  if (rec.plan !== "basic" && rec.plan !== "unlimited") return false;
  if (!rec.paid_until) return false;
  const t = Date.parse(rec.paid_until);
  if (!Number.isFinite(t)) return false;
  return Date.now() < t;
}

function isTrialActive(rec) {
  if (!rec?.trial_started_at) return false;
  const started = Date.parse(rec.trial_started_at);
  if (!Number.isFinite(started)) return false;
  const diffDays = Math.floor((Date.now() - started) / 86400000);
  return diffDays < 3; // 3 дня
}

function planDailyLimit(rec) {
  // 1) если подписка активна — она главнее
  if (isPaidActive(rec)) {
    if (rec.plan === "unlimited") return Infinity;
    if (rec.plan === "basic") return 3;
  }

  // 2) если подписка не активна — пробуем триал
  if (isTrialActive(rec)) return 3;

  // 3) иначе доступа нет
  return 0;
}

export function ensureUserRecord(contactId) {
  const id = String(contactId);
  const rec = getAccess(id);
  if (rec) return rec;

  // создаём триал при первом обращении
  return setAccess(id, {
    plan: null, // пока не оплачено
    paid_until: null,
    trial_started_at: new Date().toISOString(),
    daily_used: 0,
    day: todayStr(),
  });
}

/**
 * checkAndConsumeQuota(contactId)
 * return:
 *  { ok:true, left:number|Infinity, plan:"basic"|"unlimited"|"trial" }
 *  { ok:false, left:0, plan:null|"trial", reason:"trial"|"limit"|"no_access" }
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // сбросить счётчик, если новый день
  if (rec.day !== dayNow) {
    rec.day = dayNow;
    rec.daily_used = 0;
  }

  const limit = planDailyLimit(rec);

  // определим текущий "режим" для UI
  const modePlan = isPaidActive(rec)
    ? rec.plan
    : (isTrialActive(rec) ? "trial" : null);

  if (limit === Infinity) {
    setAccess(contactId, rec);
    return { ok: true, left: Infinity, plan: modePlan || "trial" };
  }

  if (limit <= 0) {
    // триал закончился и подписки нет
    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: modePlan, reason: "no_access" };
  }

  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);
    return { ok: true, left: Math.max(0, limit - rec.daily_used), plan: modePlan || "trial" };
  }

  // дневной лимит исчерпан
  setAccess(contactId, rec);
  return { ok: false, left: 0, plan: modePlan, reason: "limit" };
}
