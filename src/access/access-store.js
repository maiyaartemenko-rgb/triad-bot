// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

// Render persistent disk обычно смонтирован в /data
const RENDER_FILE = "/data/access.json";
const LOCAL_FILE = path.resolve(process.cwd(), "data/access.json");
const FILE = fs.existsSync("/data") ? RENDER_FILE : LOCAL_FILE;

// --- limits ---
const BASIC_DIALOG_LIMIT = 100;
const UNLIMITED_DAILY_LIMIT = 150;

// trial (можно оставить, но фактически ты используешь paywall after 2)
const TRIAL_DAILY_LIMIT = 3;
const TRIAL_DAYS = 3;

// --- micro cycle (29 ₽ / 16 Stars) ---
const MICRO_WINDOW_HOURS = 24;
const MICRO_STEPS = 12; // 12 ответов бота
const MICRO_FINAL = 1; // + финальный ответ (13-й)
const MICRO_TOTAL_ANSWERS = MICRO_STEPS + MICRO_FINAL;

// Follow-ups (оставляем совместимость)
const PAYWALL_PAUSE_DELAY_MS = 5 * 60 * 1000;
const PAYWALL_PITCH_DELAY_MS = 10 * 60 * 1000;
const UNLIMITED_NUDGE_DELAY_MS = 5 * 60 * 1000;

function ensureDbShape(db) {
  if (!db || typeof db !== "object") return { users: {} };
  if (!db.users || typeof db.users !== "object") db.users = {};
  return db;
}

function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  const data = JSON.stringify(ensureDbShape(db), null, 2);
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, FILE);
}

function safeLoad() {
  try {
    if (!fs.existsSync(FILE)) return { users: {} };
    const txt = fs.readFileSync(FILE, "utf8");
    if (!String(txt || "").trim()) return { users: {} };
    const parsed = JSON.parse(txt);
    return ensureDbShape(parsed);
  } catch (e) {
    try {
      if (fs.existsSync(FILE)) {
        const corruptCopy = `${FILE}.corrupt.${Date.now()}`;
        fs.copyFileSync(FILE, corruptCopy);
        console.error("ACCESS_DB_CORRUPT: copied to", corruptCopy);
      }
    } catch (e2) {
      console.error("ACCESS_DB_CORRUPT_COPY_FAILED:", e2);
    }
    console.error("ACCESS_DB_LOAD_ERROR:", e);
    return { users: {} };
  }
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

function isMicroActive(rec) {
  if (!rec?.micro_active_until) return false;
  const until = new Date(rec.micro_active_until).getTime();
  return Number.isFinite(until) && Date.now() < until && (rec.micro_stage === "active" || rec.micro_stage === "await_final");
}

function planLimit(rec) {
  if (!rec) return 0;

  if (rec.plan === "unlimited") return isPaidActive(rec) ? UNLIMITED_DAILY_LIMIT : 0;
  if (rec.plan === "basic") return isPaidActive(rec) ? BASIC_DIALOG_LIMIT : 0;

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

    // trial
    trial_started_at: new Date().toISOString(),
    last_reset_date: todayStr(),
    daily_used: 0,
    trial_end_notified: false,

    // BASIC
    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    // PAYWALL (после 2-го ответа)
    paywall_shown: false,
    paywall_hold_notified: false,

    // follow-ups
    paywall_pause_due_at: null,
    paywall_pause_sent: false,
    paywall_pitch_due_at: null,
    paywall_pitch_sent: false,

    // upsell unlimited
    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,

    // счётчик ответов бота (для paywall after 2)
    bot_answers_count: 0,

    // micro-cycle (29 ₽)
    micro_cycle_count: 0,
    micro_active_until: null,
    micro_started_at: null,
    micro_stage: "idle", // idle | active | await_final
    micro_used_answers: 0, // сколько ответов бота уже выдано в цикле (включая финальный)
  });
}

/**
 * checkAndConsumeQuota — теперь учитывает micro-cycle.
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // 1) истёк платный план
  if ((rec.plan === "basic" || rec.plan === "unlimited") && rec.paid_until) {
    const untilMs = new Date(rec.paid_until).getTime();
    if (Number.isFinite(untilMs) && untilMs <= Date.now()) {
      rec.plan = null;
      rec.paid_until = null;

      rec.daily_used = 0;

      rec.dialog_used = 0;
      rec.dialog_warn95_sent = false;
      rec.dialog_end100_sent = false;

      rec.paywall_shown = false;
      rec.paywall_hold_notified = false;

      rec.paywall_pause_due_at = null;
      rec.paywall_pause_sent = false;
      rec.paywall_pitch_due_at = null;
      rec.paywall_pitch_sent = false;

      rec.unlimited_upsell_shown = false;
      rec.unlimited_nudge_due_at = null;
      rec.unlimited_nudge_sent = false;

      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "paid_ended", notify: true, extra: null };
    }
  }

  // 2) новый день → сброс дневного счётчика (для trial/unlimited)
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;
  }

  const paidActive = isPaidActive(rec);

  // ✅ 0) MICRO CYCLE — приоритетнее trial/paywall
  if (isMicroActive(rec)) {
    const used = Number.isFinite(rec.micro_used_answers) ? rec.micro_used_answers : 0;
    const left = Math.max(0, MICRO_TOTAL_ANSWERS - used);

    if (left <= 0) {
      // цикл закончился, доступ отключаем
      rec.micro_stage = "idle";
      rec.micro_active_until = null;
      rec.micro_started_at = null;
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "micro_ended", notify: false, extra: null };
    }

    // consume 1 (одно пользовательское сообщение → один ответ бота)
    rec.micro_used_answers = used + 1;
    setAccess(contactId, rec);
    return {
      ok: true,
      left: MICRO_TOTAL_ANSWERS - rec.micro_used_answers,
      plan: "micro",
      reason: null,
      notify: false,
      extra: null,
    };
  }

  // ✅ PAYWALL HOLD: если включён paywall_shown и нет активного платного плана — блокируем GPT
  const hasActivePaidPlan = (rec.plan === "basic" || rec.plan === "unlimited") && paidActive;
  if (rec.paywall_shown && !hasActivePaidPlan) {
    const shouldNotify = rec.paywall_hold_notified ? false : true;
    rec.paywall_hold_notified = true;
    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: null, reason: "paywall_hold", notify: shouldNotify, extra: null };
  }

  const trialActive = isTrialActive(rec);
  const limit = planLimit(rec);

  // 3) если лимит 0 — нет доступа
  if (limit <= 0) {
    if (!trialActive && !paidActive && !rec.plan) {
      const shouldNotify = rec.trial_end_notified ? false : true;
      rec.trial_end_notified = true;
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: null, reason: "trial_ended", notify: shouldNotify, extra: null };
    }

    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: null, reason: "paid_ended", notify: true, extra: null };
  }

  // 4) BASIC: 100 сообщений
  if (rec.plan === "basic") {
    const used = Number.isFinite(rec.dialog_used) ? rec.dialog_used : 0;
    if (used >= BASIC_DIALOG_LIMIT) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "basic", reason: "dialog_limit", notify: true, extra: "end100" };
    }

    rec.dialog_used = used + 1;

    let extra = null;
    let notify = false;

    if (rec.dialog_used === 95 && !rec.dialog_warn95_sent) {
      rec.dialog_warn95_sent = true;
      extra = "warn95";
      notify = true;
    }

    if (rec.dialog_used === 100 && !rec.dialog_end100_sent) {
      rec.dialog_end100_sent = true;
      extra = "end100";
      notify = true;
    }

    setAccess(contactId, rec);
    return { ok: true, left: BASIC_DIALOG_LIMIT - rec.dialog_used, plan: "basic", reason: null, notify, extra };
  }

  // 5) UNLIMITED: 150/день
  if (rec.plan === "unlimited" && limit === UNLIMITED_DAILY_LIMIT) {
    if (rec.daily_used >= UNLIMITED_DAILY_LIMIT) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "unlimited", reason: "silent_limit", notify: false, extra: null };
    }
    rec.daily_used += 1;
    setAccess(contactId, rec);
    return { ok: true, left: UNLIMITED_DAILY_LIMIT - rec.daily_used, plan: "unlimited", reason: null, notify: false, extra: null };
  }

  // 6) TRIAL
  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);
    const planLabel = rec.plan || (trialActive ? "trial" : null);
    return { ok: true, left: limit - rec.daily_used, plan: planLabel, reason: null, notify: false, extra: null };
  }

  setAccess(contactId, rec);
  return { ok: false, left: 0, plan: rec.plan || (trialActive ? "trial" : null), reason: "daily_limit", notify: true, extra: null };
}

// совместимость
export function markUnlimitedUpsellShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();
  rec.unlimited_upsell_shown = true;
  rec.unlimited_nudge_due_at = new Date(now + UNLIMITED_NUDGE_DELAY_MS).toISOString();
  rec.unlimited_nudge_sent = false;
  return setAccess(contactId, rec);
}

export function deleteAccess(contactId) {
  const db = safeLoad();
  const key = String(contactId);
  if (db.users && db.users[key]) {
    delete db.users[key];
    safeSave(db);
  }
  return true;
}
