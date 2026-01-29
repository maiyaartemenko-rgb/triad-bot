// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

// Render persistent disk обычно смонтирован в /data
const RENDER_FILE = "/data/access.json";
// Локально — ./data/access.json
const LOCAL_FILE = path.resolve(process.cwd(), "data/access.json");

// ✅ всегда пишем в /data если он доступен, иначе локально
const FILE = fs.existsSync("/data") ? RENDER_FILE : LOCAL_FILE;

// Лимиты
const UNLIMITED_DAILY_LIMIT = 150;
const BASIC_DAILY_LIMIT = 3;
const TRIAL_DAILY_LIMIT = 3;
const TRIAL_DAYS = 3;

function safeLoad() {
  try {
    const txt = fs.readFileSync(FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { users: {} };
  }
}

function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}

export function getAccess(contactId) {
  const db = safeLoad();
  return db.users[String(contactId)] || null;
}

export function setAccess(contactId, data) {
  const db = safeLoad();
  const key = String(contactId);
  db.users[key] = { ...(db.users[key] || {}), ...(data || {}) };
  safeSave(db);
  return db.users[key];
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysSinceISO(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400000);
}

function isTrialActive(rec) {
  if (!rec?.trial_started_at) return false;
  return daysSinceISO(rec.trial_started_at) < TRIAL_DAYS;
}

function isPaidActive(rec) {
  if (!rec?.paid_until) return false;
  const until = new Date(rec.paid_until).getTime();
  return Number.isFinite(until) && Date.now() < until;
}

function planDailyLimit(rec) {
  if (!rec) return 0;

  // Платные планы действуют только пока paid_until активен
  if (rec.plan === "unlimited") return isPaidActive(rec) ? UNLIMITED_DAILY_LIMIT : 0;
  if (rec.plan === "basic") return isPaidActive(rec) ? BASIC_DAILY_LIMIT : 0;

  // Триал
  if (isTrialActive(rec)) return TRIAL_DAILY_LIMIT;

  return 0;
}

export function ensureUserRecord(contactId) {
  const key = String(contactId);
  const existing = getAccess(key);
  if (existing) return existing;

  return setAccess(key, {
    plan: null,
    paid_until: null,
    trial_started_at: new Date().toISOString(),
    last_reset_date: todayStr(),
    daily_used: 0,

    // ✅ чтобы на 4-й день не спамить paywall каждый раз
    trial_end_notified: false,
  });
}

/**
 * Возвращает:
 * ok: true|false
 * left: сколько осталось сегодня
 * plan: "trial" | "basic" | "unlimited" | null
 * reason: null | "daily_limit" | "trial_ended" | "paid_ended" | "silent_limit"
 * notify: true|false (важно только для trial_ended)
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // 1) если подписка истекла — сбрасываем план (но помечаем paid_ended)
  let paidJustEnded = false;
  if ((rec.plan === "basic" || rec.plan === "unlimited") && rec.paid_until) {
    const untilMs = new Date(rec.paid_until).getTime();
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      paidJustEnded = true;
      rec.plan = null;
      rec.paid_until = null;
      rec.daily_used = 0;
    }
  }

  // 2) новый день → сбрасываем дневной счётчик
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;

    // если триал закончился давно — на новый день не надо снова спамить paywall
    // trial_end_notified оставляем как есть (true останется true)
  }

  const trialActive = isTrialActive(rec);
  const paidActive = isPaidActive(rec);
  const limit = planDailyLimit(rec);

  // 3) если лимит 0 — значит нет доступа (trial_ended или paid_ended)
  if (limit <= 0) {
    // trial закончился
    if (!trialActive && !paidActive && !rec.plan) {
      const shouldNotify = rec.trial_end_notified ? false : true;
      rec.trial_end_notified = true;
      setAccess(contactId, rec);
      return {
        ok: false,
        left: 0,
        plan: null,
        reason: "trial_ended",
        notify: shouldNotify,
      };
    }

    // подписка закончилась
    setAccess(contactId, rec);
    return {
      ok: false,
      left: 0,
      plan: null,
      reason: paidJustEnded ? "paid_ended" : "paid_ended",
      notify: true,
    };
  }

  // 4) unlimited: если достигли 150 — молчим (silent_limit)
  if (rec.plan === "unlimited" && limit === UNLIMITED_DAILY_LIMIT) {
    if (rec.daily_used >= UNLIMITED_DAILY_LIMIT) {
      setAccess(contactId, rec);
      return {
        ok: false,
        left: 0,
        plan: "unlimited",
        reason: "silent_limit",
        notify: false,
      };
    }

    rec.daily_used += 1;
    setAccess(contactId, rec);
    return {
      ok: true,
      left: UNLIMITED_DAILY_LIMIT - rec.daily_used,
      plan: "unlimited",
      reason: null,
      notify: false,
    };
  }

  // 5) обычные лимиты (trial/basic): 3 в день
  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);

    const planLabel = rec.plan || (trialActive ? "trial" : null);
    return {
      ok: true,
      left: limit - rec.daily_used,
      plan: planLabel,
      reason: null,
      notify: false,
    };
  }

  // 6) дневной лимит исчерпан
  setAccess(contactId, rec);
  return {
    ok: false,
    left: 0,
    plan: rec.plan || (trialActive ? "trial" : null),
    reason: "daily_limit",
    notify: true,
  };
}
