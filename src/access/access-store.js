// src/access/access-store.js
import fs from "node:fs";
import path from "node:path";

// Render persistent disk обычно смонтирован в /data
const RENDER_FILE = "/data/access.json";
const LOCAL_FILE = path.resolve(process.cwd(), "data/access.json");

// ✅ всегда пишем в /data если он доступен, иначе локально
const FILE = fs.existsSync("/data") ? RENDER_FILE : LOCAL_FILE;

// ===================== LIMITS (старые тарифы оставляем) =====================
const BASIC_DIALOG_LIMIT = 100;
const UNLIMITED_DAILY_LIMIT = 150;

// Trial (как было)
const TRIAL_DAILY_LIMIT = 3;
const TRIAL_DAYS = 3;

// ===================== MICRO-CYCLE (Stars 29₽ / 16 ⭐) =====================
// По новой логике:
// - В “микро-цикле” бот отвечает на 2 сообщения бесплатно (как раньше),
// - Затем оплата -> даём ещё 13 ответов бота (12 + финальный 13-й).
// - Окно доступа к “12 шагам” = 24 часа с момента оплаты.
// - Циклы считаем навсегда: cycle_total_count = 1,2,3... без остановки.
// - Счётчик можно “обнулять раз в месяц” (по желанию) — сделаем мягко:
//   monthly_cycle_counter (сбрасывается при смене YYYY-MM).
const MICRO_WINDOW_HOURS = 24;
const MICRO_EXTRA_BOT_ANSWERS = 13; // 12 шагов + финальный вопрос = 13 ответов

// ===================== FOLLOW-UPS (оставляем совместимость) =====================
const PAYWALL_PAUSE_DELAY_MS = 5 * 60 * 1000;
const PAYWALL_PITCH_DELAY_MS = 10 * 60 * 1000;
const UNLIMITED_NUDGE_DELAY_MS = 5 * 60 * 1000;

// -------------------- db helpers --------------------

function ensureDbShape(db) {
  if (!db || typeof db !== "object") return { users: {} };
  if (!db.users || typeof db.users !== "object") db.users = {};
  return db;
}

// ✅ атомарная запись
function safeSave(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  const data = JSON.stringify(ensureDbShape(db), null, 2);
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, FILE);
}

/**
 * ✅ НЕ переименовываем основной файл.
 * Если JSON битый — копируем в *.corrupt.*, возвращаем пустую базу.
 */
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

export function deleteAccess(contactId) {
  const db = safeLoad();
  const key = String(contactId);
  if (db.users && db.users[key]) {
    delete db.users[key];
    safeSave(db);
  }
  return true;
}

// -------------------- time helpers --------------------

function todayStr() {
  // UTC день — ок для Render
  return new Date().toISOString().slice(0, 10);
}

function monthStr() {
  // YYYY-MM (UTC)
  return new Date().toISOString().slice(0, 7);
}

function addHoursISO(hours) {
  const d = new Date();
  d.setHours(d.getHours() + Number(hours || 0));
  return d.toISOString();
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
  if (!rec?.micro_cycle_until) return false;
  const until = new Date(rec.micro_cycle_until).getTime();
  return Number.isFinite(until) && Date.now() < until;
}

function planLimit(rec) {
  if (!rec) return 0;

  // paid plans
  if (rec.plan === "unlimited") return isPaidActive(rec) ? UNLIMITED_DAILY_LIMIT : 0;
  if (rec.plan === "basic") return isPaidActive(rec) ? BASIC_DIALOG_LIMIT : 0;

  // micro-cycle (оплаченный 24ч доступ на доп. ответы)
  // тут лимит не “в день”, а лимит доп. ответов в рамках окна
  if (isMicroActive(rec)) return MICRO_EXTRA_BOT_ANSWERS;

  // trial
  if (isTrialActive(rec)) return TRIAL_DAILY_LIMIT;

  return 0;
}

// -------------------- user record --------------------

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

    // paywall after 2 answers (флаг “сервер больше не отвечает”)
    paywall_shown: false,
    paywall_hold_notified: false,

    // счётчик ответов бота (для “после 2-го ответа”)
    bot_answers_count: 0,

    // BASIC 100/мес
    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    // upsell unlimited
    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,

    // follow-ups (совместимость)
    paywall_pause_due_at: null,
    paywall_pause_sent: false,
    paywall_pitch_due_at: null,
    paywall_pitch_sent: false,

    // ===================== MICRO-CYCLE FIELDS =====================
    // активное окно 24 часа после оплаты
    micro_cycle_until: null, // ISO
    micro_used_bot_answers: 0, // сколько доп. ответов уже потратили в текущем окне (0..13)

    // счетчики циклов
    cycle_total_count: 0, // растёт навсегда
    cycle_month: monthStr(),
    cycle_month_count: 0, // сбрасывается при смене месяца (по желанию)

    // чтобы можно было разово уведомлять об окончании окна (если пригодится)
    micro_expired_notified: false,
  });
}

// -------------------- MICRO-CYCLE API --------------------

/**
 * Вызывать после успешной оплаты “12 шагов за 29 ₽”.
 * Активирует окно на 24ч и даёт 13 доп. ответов бота.
 * Также увеличивает счётчики циклов (навсегда + ежемесячный).
 */
export function startMicroCycle(contactId) {
  const rec = ensureUserRecord(contactId);

  // ежемесячный счётчик
  const m = monthStr();
  if (rec.cycle_month !== m) {
    rec.cycle_month = m;
    rec.cycle_month_count = 0;
  }

  rec.cycle_total_count = Number(rec.cycle_total_count || 0) + 1;
  rec.cycle_month_count = Number(rec.cycle_month_count || 0) + 1;

  // активируем окно и лимит
  rec.micro_cycle_until = addHoursISO(MICRO_WINDOW_HOURS);
  rec.micro_used_bot_answers = 0;
  rec.micro_expired_notified = false;

  // важно: после оплаты мы НЕ должны оставаться в paywall_hold
  rec.paywall_shown = false;
  rec.paywall_hold_notified = false;

  // и логично сбросить 2 бесплатных ответа “на следующий цикл”
  // (если хочешь оставить как есть — можно убрать)
  rec.bot_answers_count = 0;

  return setAccess(contactId, rec);
}

/**
 * Можно дергать, когда надо принудительно закончить активное окно.
 */
export function endMicroCycle(contactId) {
  const rec = ensureUserRecord(contactId);
  rec.micro_cycle_until = null;
  rec.micro_used_bot_answers = 0;
  rec.micro_expired_notified = false;
  return setAccess(contactId, rec);
}

/**
 * Трата “доп. ответов” внутри оплаченного окна.
 * Вызывается ПОСЛЕ того, как сервер отправил очередной ответ бота.
 *
 * Возвращает:
 *  ok: true/false
 *  left: сколько осталось (0..13)
 *  reason: null | "micro_expired" | "micro_limit"
 */
export function consumeMicroBotAnswer(contactId) {
  const rec = ensureUserRecord(contactId);

  if (!isMicroActive(rec)) {
    // окно кончилось
    rec.micro_cycle_until = null;
    rec.micro_used_bot_answers = 0;
    setAccess(contactId, rec);
    return { ok: false, left: 0, reason: "micro_expired" };
  }

  const used = Number.isFinite(rec.micro_used_bot_answers) ? rec.micro_used_bot_answers : 0;
  if (used >= MICRO_EXTRA_BOT_ANSWERS) {
    setAccess(contactId, rec);
    return { ok: false, left: 0, reason: "micro_limit" };
  }

  rec.micro_used_bot_answers = used + 1;
  setAccess(contactId, rec);

  return { ok: true, left: MICRO_EXTRA_BOT_ANSWERS - rec.micro_used_bot_answers, reason: null };
}

export function getMicroState(contactId) {
  const rec = ensureUserRecord(contactId);
  return {
    active: isMicroActive(rec),
    until: rec.micro_cycle_until || null,
    used: Number(rec.micro_used_bot_answers || 0),
    left: Math.max(0, MICRO_EXTRA_BOT_ANSWERS - Number(rec.micro_used_bot_answers || 0)),
    cycle_total_count: Number(rec.cycle_total_count || 0),
    cycle_month: rec.cycle_month || monthStr(),
    cycle_month_count: Number(rec.cycle_month_count || 0),
  };
}

// -------------------- MAIN QUOTA (старое) --------------------

/**
 * Возвращает:
 * ok: true|false
 * left: сколько осталось
 * plan: "trial" | "basic" | "unlimited" | "micro" | null
 * reason:
 *  - null
 *  - "paywall_hold"
 *  - "daily_limit"
 *  - "trial_ended"
 *  - "paid_ended"
 *  - "silent_limit"
 *  - "dialog_limit"
 *  - "micro_expired"
 *  - "micro_limit"
 * notify: true|false
 * extra: null | "warn95" | "end100"
 */
export function checkAndConsumeQuota(contactId) {
  const rec = ensureUserRecord(contactId);
  const dayNow = todayStr();

  // 0) ежемесячный счётчик (на всякий)
  const m = monthStr();
  if (rec.cycle_month !== m) {
    rec.cycle_month = m;
    rec.cycle_month_count = 0;
  }

  // 1) если подписка истекла — сбрасываем план (и счетчики)
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

  // 2) новый день → сброс дневного счётчика (trial/unlimited)
  if (rec.last_reset_date !== dayNow) {
    rec.last_reset_date = dayNow;
    rec.daily_used = 0;
  }

  const trialActive = isTrialActive(rec);
  const paidActive = isPaidActive(rec);
  const limit = planLimit(rec);

  // 3) MICRO имеет приоритет над trial/paywall (если окно активно — отвечаем)
  if (isMicroActive(rec)) {
    const used = Number.isFinite(rec.micro_used_bot_answers) ? rec.micro_used_bot_answers : 0;

    if (used >= MICRO_EXTRA_BOT_ANSWERS) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "micro", reason: "micro_limit", notify: true, extra: null };
    }

    // Тут мы НЕ увеличиваем micro_used_bot_answers — потому что это нужно делать
    // после реальной отправки ответа бота (в webhook) через consumeMicroBotAnswer().
    // Здесь лишь разрешаем “в принципе”.
    return {
      ok: true,
      left: MICRO_EXTRA_BOT_ANSWERS - used,
      plan: "micro",
      reason: null,
      notify: false,
      extra: null,
    };
  }

  // 4) PAYWALL HOLD: после 2-го ответа (без оплаты) — блокируем GPT
  // Важно: платным НЕ мешаем.
  const hasActivePaidPlan = (rec.plan === "basic" || rec.plan === "unlimited") && paidActive;

  if (rec.paywall_shown && !hasActivePaidPlan) {
    const shouldNotify = rec.paywall_hold_notified ? false : true;
    rec.paywall_hold_notified = true;
    setAccess(contactId, rec);
    return { ok: false, left: 0, plan: null, reason: "paywall_hold", notify: shouldNotify, extra: null };
  }

  // 5) если лимит 0 — нет доступа (trial/pay ended)
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

  // 6) BASIC: 100 сообщений за срок paid_until
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

  // 7) UNLIMITED: 150/день, silent_limit
  if (rec.plan === "unlimited" && limit === UNLIMITED_DAILY_LIMIT) {
    if (rec.daily_used >= UNLIMITED_DAILY_LIMIT) {
      setAccess(contactId, rec);
      return { ok: false, left: 0, plan: "unlimited", reason: "silent_limit", notify: false, extra: null };
    }

    rec.daily_used += 1;
    setAccess(contactId, rec);
    return { ok: true, left: UNLIMITED_DAILY_LIMIT - rec.daily_used, plan: "unlimited", reason: null, notify: false, extra: null };
  }

  // 8) TRIAL
  if (rec.daily_used < limit) {
    rec.daily_used += 1;
    setAccess(contactId, rec);
    const planLabel = rec.plan || (trialActive ? "trial" : null);
    return { ok: true, left: limit - rec.daily_used, plan: planLabel, reason: null, notify: false, extra: null };
  }

  // 9) trial дневной лимит исчерпан
  setAccess(contactId, rec);
  return { ok: false, left: 0, plan: rec.plan || (trialActive ? "trial" : null), reason: "daily_limit", notify: true, extra: null };
}

// -------------------- followup exports (совместимость) --------------------

export function markPaywallShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.paywall_shown = true;
  rec.paywall_hold_notified = false;

  rec.paywall_pause_due_at = new Date(now + PAYWALL_PAUSE_DELAY_MS).toISOString();
  rec.paywall_pause_sent = false;

  rec.paywall_pitch_due_at = new Date(now + PAYWALL_PITCH_DELAY_MS).toISOString();
  rec.paywall_pitch_sent = false;

  return setAccess(contactId, rec);
}

export function markUnlimitedUpsellShown(contactId) {
  const rec = ensureUserRecord(contactId);
  const now = Date.now();

  rec.unlimited_upsell_shown = true;
  rec.unlimited_nudge_due_at = new Date(now + UNLIMITED_NUDGE_DELAY_MS).toISOString();
  rec.unlimited_nudge_sent = false;

  return setAccess(contactId, rec);
}

export function consumeDueFollowups() {
  const db = safeLoad();
  const nowMs = Date.now();

  const duePaywallPause = [];
  const duePaywallPitch = [];
  const dueUnlimited = [];

  for (const [contactId, rec] of Object.entries(db.users || {})) {
    if (!rec) continue;

    if (rec.paywall_shown && !rec.paywall_pause_sent && rec.paywall_pause_due_at) {
      const dueMs = new Date(rec.paywall_pause_due_at).getTime();
      const stillNotPaid = !isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && stillNotPaid) {
        rec.paywall_pause_sent = true;
        duePaywallPause.push(contactId);
      }
    }

    if (rec.paywall_shown && !rec.paywall_pitch_sent && rec.paywall_pitch_due_at) {
      const dueMs = new Date(rec.paywall_pitch_due_at).getTime();
      const stillNotPaid = !isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && stillNotPaid) {
        rec.paywall_pitch_sent = true;
        duePaywallPitch.push(contactId);
      }
    }

    if (rec.unlimited_upsell_shown && !rec.unlimited_nudge_sent && rec.unlimited_nudge_due_at) {
      const dueMs = new Date(rec.unlimited_nudge_due_at).getTime();
      const unlimitedActive = rec.plan === "unlimited" && isPaidActive(rec);
      if (Number.isFinite(dueMs) && dueMs <= nowMs && !unlimitedActive) {
        rec.unlimited_nudge_sent = true;
        dueUnlimited.push(contactId);
      }
    }
  }

  safeSave(db);
  return { paywallPause: duePaywallPause, paywallPitch: duePaywallPitch, unlimited: dueUnlimited };
}

export function resetDialogCounters(contactId) {
  const rec = ensureUserRecord(contactId);

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

  return setAccess(contactId, rec);
}
