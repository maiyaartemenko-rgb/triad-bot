// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

// Render persistent disk обычно смонтирован в /data
const RENDER_DISK = "/data/access.json";

// Локально — пусть будет ./data/access.json
const LOCAL_FILE = path.resolve(process.cwd(), "data/access.json");

// ✅ всегда пишем в /data если он доступен, иначе локально
const FILE = fs.existsSync("/data") ? RENDER_DISK : LOCAL_FILE;

function safeLoad() {
  try {
    const txt = fs.readFileSync(FILE, "utf8");
    return JSON.parse(txt);
  } catch {
    return { users: {} }; // { users: { [contactId]: { plan, paid_until, daily_used, last_reset_date, trial_started_at } } }
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
    plan: null, // null = не оплачен
    trial_started_at: new Date().toISOString(),
    daily_used: 0,
    last_reset_date: todayStr(),
    paid_until: null,
  });
}

/**
 * Возвращает:
 * ok: true|false
 * left: сколько осталось сегодня
 * plan: "trial" | "basic" | "unlimited" | null
 * reason: null | "daily_limit" | "trial_ended"
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // сбросить счётчик, если новый день
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;
  }

  const trialActive = isTrialActive(rec);
  const limit = planDailyLimit(rec);

  // unlimited
  if (limit === Infinity) {
    setAccess(contactId, rec);
    return { ok: true, left: Infinity, plan: rec.plan || "unlimited", reason: null };
  }

  // если лимит = 0 (например триал кончился и план не куплен)
  if (limit <= 0) {
    setAccess(contactId, rec);
    return {
      ok: false,
      left: 0,
      plan: rec.plan || (trialActive ? "trial" : null),
      reason: "trial_ended",
    };
  }

  // есть лимит и ещё осталось
  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);

    const planLabel = rec.plan || (trialActive ? "trial" : null);

    return {
      ok: true,
      left: limit - rec.daily_used,
      plan: planLabel,
      reason: null,
    };
  }

  // лимит исчерпан
  setAccess(contactId, rec);

  const planLabel = rec.plan || (trialActive ? "trial" : null);

  // ✅ различаем:
  // - trialActive=true → завтра снова можно
  // - trialActive=false и plan=null → триал завершён
  // - basic тоже завтра можно, но это тоже daily_limit
  const reason = trialActive || rec.plan ? "daily_limit" : "trial_ended";

  return { ok: false, left: 0, plan: planLabel, reason };
}
