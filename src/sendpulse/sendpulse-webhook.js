// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";

import {
  sendpulseTelegramSendText,
  sendpulseStartFlow,
  sendpulseSetContactVariables,
} from "./sendpulse-api.js";

import { setTgMap, getContactIdByTgId } from "../access/tg-map-store.js";
import { getHistory, pushToHistory, clearHistory } from "../src/memory/memory-store.js";

import {
  checkAndConsumeQuota,
  getAccess,
  setAccess,
  markUnlimitedUpsellShown,
  deleteAccess,
} from "../access/access-store.js";

// ==================== CONFIG ====================

const PAYWALL_BY_SENDPULSE = true;

// первая воронка оплаты (после 2 бесплатных ответов)
const SP_PAY_16_STARS_FLOW_ID = String(process.env.SP_PAY_16_STARS_FLOW_ID || "").trim();

// повторная воронка (после завершения цикла)
const SP_PAY_16_STARS_REPEAT_FLOW_ID = String(process.env.SP_PAY_16_STARS_REPEAT_FLOW_ID || "").trim();

// переменная SendPulse, которую выставляет воронка после оплаты (значение 1)
const SP_PAID_FLAG_VAR = String(process.env.SP_MICRO_PAID_VAR || "PAID_16_STARS_12_STEPS").trim();

// переменная SendPulse, куда сервер пишет количество циклов (для ветвления repeat-воронки)
const SP_MICRO_CYCLE_COUNT_VAR = String(process.env.SP_MICRO_CYCLE_COUNT_VAR || "MICRO_CYCLE_COUNT").trim();

// micro config
const MICRO_WINDOW_HOURS = 24;
const MICRO_STEPS = 12;
const MICRO_TOTAL_ANSWERS = 13;

// ==================== helpers ====================

function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : payload ?? {};
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function addHoursISO(hours) {
  const d = new Date();
  d.setHours(d.getHours() + Number(hours || 0));
  return d.toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtIsoRu(iso) {
  try {
    return new Date(iso).toLocaleString("ru-RU");
  } catch {
    return String(iso || "");
  }
}

function extractText(event) {
  return event?.info?.message?.channel_data?.message?.text ?? event?.contact?.last_message ?? "";
}

function extractContactId(event) {
  return event?.contact?.id ?? null;
}

function extractTelegramUserId(event) {
  const candidates = [
    event?.info?.message?.channel_data?.message?.from?.id,
    event?.info?.message?.channel_data?.from?.id,
    event?.info?.message?.channel_data?.message?.chat?.id,
    event?.info?.message?.channel_data?.chat?.id,
    event?.contact?.telegram_user_id,
    event?.contact?.telegram_id,
    event?.contact?.external_id,
  ];
  const v = candidates.find((x) => x !== undefined && x !== null && safeStr(x) !== "");
  return v ? safeStr(v) : null;
}

function isAdmin(event) {
  const adminTgId = String(process.env.ADMIN_TG_ID || "").trim();
  if (!adminTgId) return false;
  const tgId = extractTelegramUserId(event);
  return tgId && String(tgId) === adminTgId;
}

function normalizeMainSignFromVars(vars) {
  const raw = vars?.Animal || vars?.animal || "";
  return safeStr(raw).replace(/[^\p{L}\s-]/gu, "").trim().toUpperCase();
}

function parseActiveSigns(vars) {
  const raw = vars?.active_signs || "";
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({ sign: safeStr(x?.sign).toUpperCase(), pct: Number(x?.pct ?? 0) }))
      .filter((x) => x.sign && Number.isFinite(x.pct));
  } catch (err) {
    console.error("Bad active_signs JSON:", err);
    return [];
  }
}

function decodeHtmlEntities(s = "") {
  return String(s).replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function isPaidActive(rec) {
  if (!rec?.paid_until) return false;
  const t = new Date(rec.paid_until).getTime();
  return Number.isFinite(t) && Date.now() < t;
}

function isMicroActive(rec) {
  if (!rec?.micro_active_until) return false;
  const t = new Date(rec.micro_active_until).getTime();
  return (
    Number.isFinite(t) &&
    Date.now() < t &&
    (rec.micro_stage === "active" || rec.micro_stage === "await_final")
  );
}

function isTruthyFlagValue(v) {
  const s = safeStr(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

// ==================== TEXTS ====================

const MICRO_FINAL_QUESTION_TEXT = [
  "✅ Мы прошли 12 шагов.",
  "",
  "Сейчас важно зафиксировать главное 🧩",
  "Последний вопрос — и завершим этот цикл 🌿",
  "",
  "🔹 <b>Финальный вопрос</b>",
  "Если собрать всё, что ты увидел(а),",
  "что стало самым важным для тебя сегодня? ✨",
].join("\n");

// BASIC 95/100 и апселл Tribute (оставляем)
const BASIC_95_WARN_TEXT = [
  "Мы подходим к завершению этого разговора 🔚",
  "",
  "Я хочу собрать главное 🧩",
  "и зафиксировать то, что для тебя сейчас ключевое ✨",
  "",
  "💬 Ответь коротко:",
  "1️⃣ Что самое важное из разговора?",
  "2️⃣ Что стало яснее?",
  "3️⃣ Если вернёшься — про что будет продолжение?",
  "4️⃣ В каком ты сейчас состоянии по сравнению с началом?",
  "5️⃣ Одна фраза итога — какая?",
].join("\n");

const BASIC_100_END_TEXT = [
  "Мы завершили этот разговор 😌",
  "",
  "Если захочешь разобрать другую тему или пойти глубже — можно начать новый диалог 💬✨",
].join("\n");

const UNLIMITED_HARD_UPSELL_TEXT = [
  "😈 Окей, честно.",
  "100 сообщений — это уже не «потестить». Это работа.",
  "",
  "Самая дорогая ошибка тут — закрыть «на потом»…",
  "и через неделю снова оказаться в той же точке. ⚠️",
  "",
  "Безлимит — когда ты не копишь,",
  "а разбираешь всё по факту появления:",
  "отношения, деньги, выбор, тревогу, границы.",
  "",
  "Хочешь выйти из сценария — не делай паузу.",
  "Открывай безлимит и добивай до результата. 💥",
].join("\n");

// ==================== Tribute links ====================

function getPublicBaseUrl(req) {
  const envBase = safeStr(process.env.PUBLIC_BASE_URL);
  if (envBase) return envBase.replace(/\/$/, "");

  const proto = safeStr(req.headers["x-forwarded-proto"]) || "https";
  const host = safeStr(req.headers["x-forwarded-host"]) || safeStr(req.headers.host);
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function getPayLinks(req, contactId) {
  const base = getPublicBaseUrl(req);
  if (!base) return { basic: null, unlimited: null };
  return {
    basic: `${base}/pay/basic?cid=${encodeURIComponent(contactId)}`,
    unlimited: `${base}/pay/unlimited?cid=${encodeURIComponent(contactId)}`,
  };
}

async function sendUnlimitedUpsellWithLink(req, contactId, prefixText = "") {
  const { unlimited } = getPayLinks(req, contactId);
  if (!unlimited) {
    await sendpulseTelegramSendText({
      contactId,
      text: `${prefixText}\n\n⚠️ Не могу построить ссылку на безлимит.\nПроверь PUBLIC_BASE_URL и роут /pay/unlimited`,
    });
    return;
  }

  const out = `${prefixText}\n\n👉 <a href="${unlimited}">Открыть безлимит — 2990 ₽</a>`;
  await sendpulseTelegramSendText({ contactId, text: out });
}

// ==================== FLOW START HELPERS ====================

async function startFlowSafe({ flowId, contactId }) {
  const fid = String(flowId || "").trim();
  if (!fid) return { ok: false, reason: "no_flow_id" };

  try {
    await sendpulseStartFlow({ flowId: fid, contactId });
    return { ok: true };
  } catch (e) {
    console.error("sendpulseStartFlow error:", e);
    return { ok: false, reason: "api_error" };
  }
}

async function startPayFlow(contactId) {
  if (!PAYWALL_BY_SENDPULSE) return { ok: false, reason: "disabled" };
  return startFlowSafe({ flowId: SP_PAY_16_STARS_FLOW_ID, contactId });
}

async function startRepeatPayFlow(contactId) {
  if (!PAYWALL_BY_SENDPULSE) return { ok: false, reason: "disabled" };
  // repeat обязателен, но если не задан — fallback на основной
  const fid = SP_PAY_16_STARS_REPEAT_FLOW_ID || SP_PAY_16_STARS_FLOW_ID;
  return startFlowSafe({ flowId: fid, contactId });
}

// ==================== MICRO: activate if paid flag is set ====================

async function tryActivateMicroFromSendPulseFlag({ contactId, vars }) {
  const paidFlag = isTruthyFlagValue(vars?.[SP_PAID_FLAG_VAR]);
  if (!paidFlag) return { ok: false, reason: "no_flag" };

  const rec = getAccess(contactId) || {};

  // уже активен — просто сбросим флаг
  if (isMicroActive(rec)) {
    try {
      await sendpulseSetContactVariables({ contactId, variables: { [SP_PAID_FLAG_VAR]: "0" } });
    } catch {}
    return { ok: true, already: true };
  }

  const cycleCount = Number.isFinite(rec.micro_cycle_count) ? rec.micro_cycle_count : 0;
  const nextCycle = cycleCount + 1;

  setAccess(contactId, {
    micro_cycle_count: nextCycle,
    micro_active_until: addHoursISO(MICRO_WINDOW_HOURS),
    micro_started_at: new Date().toISOString(),
    micro_stage: "active",
    micro_used_answers: 0,

    paywall_shown: false,
    paywall_hold_notified: false,
  });

  // ✅ пишем счётчик циклов в SendPulse (для ветвления repeat-воронки)
  try {
    await sendpulseSetContactVariables({
      contactId,
      variables: {
        [SP_MICRO_CYCLE_COUNT_VAR]: String(nextCycle),
        [SP_PAID_FLAG_VAR]: "0",
      },
    });
  } catch (e) {
    // даже если не записалось — micro всё равно активен на сервере
    console.error("sendpulseSetContactVariables cycle_count error:", e);
    try {
      await sendpulseSetContactVariables({ contactId, variables: { [SP_PAID_FLAG_VAR]: "0" } });
    } catch {}
  }

  return { ok: true, activated: true, cycle: nextCycle };
}

// ==================== ADMIN ====================

async function grantPlanToContact({ contactId, plan, days = 30 }) {
  const paid_until = addDaysISO(days);

  setAccess(contactId, {
    plan,
    paid_until,
    last_reset_date: todayStr(),
    daily_used: 0,

    paywall_shown: false,
    paywall_hold_notified: false,
    bot_answers_count: 0,

    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,
  });

  try {
    clearHistory(contactId);
  } catch {}

  return { ok: true, plan, paid_until };
}

// ==================== main ====================

export async function handleSendpulseWebhook(req, res) {
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = safeStr(extractText(event));
    const contactId = extractContactId(event);
    if (!contactId || !text) return;

    const tgId = extractTelegramUserId(event);
    if (tgId) {
      try {
        setTgMap(String(tgId), String(contactId));
      } catch (e) {
        console.error("setTgMap error:", e);
      }
    }

    const lower = text.toLowerCase();

    // /start — молчим
    if (lower === "/start") return;

    const vars = event?.contact?.variables || {};

    // 1) если был флаг оплаты — активируем micro
    try {
      await tryActivateMicroFromSendPulseFlag({ contactId, vars });
    } catch (e) {
      console.error("tryActivateMicroFromSendPulseFlag error:", e);
    }

    // ADMIN
    if (lower === "/whoami") {
      const myTgId = extractTelegramUserId(event);
      await sendpulseTelegramSendText({
        contactId,
        text: `tgId: <b>${safeStr(myTgId) || "?"}</b>\ncontactId: <b>${safeStr(contactId)}</b>`,
      });
      return;
    }

    if (lower.startsWith("/grant_basic")) {
      if (!isAdmin(event)) return;
      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      const days = parts[2] ? Number(parts[2]) : 30;
      if (!targetTgId) return;

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) return;

      const r = await grantPlanToContact({ contactId: targetContactId, plan: "basic", days });
      await sendpulseTelegramSendText({
        contactId,
        text: `✅ Выдан BASIC\ncontactId=${targetContactId}\npaid_until=${fmtIsoRu(r.paid_until)}`,
      });
      return;
    }

    if (lower.startsWith("/grant_unlimited")) {
      if (!isAdmin(event)) return;
      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      const days = parts[2] ? Number(parts[2]) : 30;
      if (!targetTgId) return;

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) return;

      const r = await grantPlanToContact({ contactId: targetContactId, plan: "unlimited", days });
      await sendpulseTelegramSendText({
        contactId,
        text: `✅ Выдан UNLIMITED\ncontactId=${targetContactId}\npaid_until=${fmtIsoRu(r.paid_until)}`,
      });
      return;
    }

    if (lower === "/reset") {
      if (!isAdmin(event)) return;
      try {
        clearHistory(contactId);
      } catch {}
      try {
        deleteAccess(contactId);
      } catch (e) {
        console.error("deleteAccess error:", e);
      }
      await sendpulseTelegramSendText({
        contactId,
        text: "✅ Полный сброс сделан. Теперь ты как новый пользователь.",
      });
      return;
    }

    // PAYWALL SILENCE
    const rec0 = getAccess(contactId) || {};
    const paidActive0 = isPaidActive(rec0);
    const microActive0 = isMicroActive(rec0);

    if (PAYWALL_BY_SENDPULSE && !paidActive0 && !microActive0 && rec0.paywall_shown) {
      return;
    }

    // LIMITS BEFORE GPT
    const gate = checkAndConsumeQuota(contactId);

    if (!gate.ok) {
      const recX = getAccess(contactId) || {};
      const paidX = isPaidActive(recX);
      const microX = isMicroActive(recX);

      if (PAYWALL_BY_SENDPULSE && !paidX && !microX && !recX.paywall_shown) {
        setAccess(contactId, { paywall_shown: true, paywall_hold_notified: false });
        await startPayFlow(contactId);
      }
      return;
    }

    // memory
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // profile
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = { main_sign: main_sign || "БАРСУК", active_signs };

    // partner
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // GPT
    let result;
    try {
      result = await triadChat({
        userText: text,
        profile,
        partnerSign,
        history,
        model: process.env.OPENAI_MODEL || "gpt-5.2",
        temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6),
      });
    } catch (e) {
      console.error("TRIAD_CHAT_ERROR:", e);
      await sendpulseTelegramSendText({
        contactId,
        text: "Сейчас технический сбой. Попробуй ещё раз через минуту 🙏",
      });
      return;
    }

    const answer = safeStr(result?.answer) || "Ок. Сформулируй вопрос чуть конкретнее 🙂";
    await sendpulseTelegramSendText({ contactId, text: decodeHtmlEntities(answer) });
    pushToHistory(contactId, "assistant", answer);

    // BASIC 95/100
    if (gate?.extra === "warn95" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_95_WARN_TEXT });
    }

    if (gate?.extra === "end100" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_100_END_TEXT });
      await sendUnlimitedUpsellWithLink(req, contactId, UNLIMITED_HARD_UPSELL_TEXT);
      try {
        markUnlimitedUpsellShown(contactId);
      } catch {}
    }

    // after-send: paywall after 2 (только если не платно и не micro)
    {
      const rec = getAccess(contactId) || {};
      const paid = isPaidActive(rec);
      const micro = isMicroActive(rec);

      if (!paid && !micro) {
        const prev = Number.isFinite(rec.bot_answers_count) ? rec.bot_answers_count : 0;
        const next = prev + 1;
        setAccess(contactId, { bot_answers_count: next });

        if (next >= 2 && !rec.paywall_shown) {
          setAccess(contactId, { paywall_shown: true, paywall_hold_notified: false });
          await startPayFlow(contactId);
        }
      }
    }

    // MICRO финализация
    const recAfter = getAccess(contactId) || {};
    if (gate.plan === "micro" && isMicroActive(recAfter)) {
      const used = Number.isFinite(recAfter.micro_used_answers) ? recAfter.micro_used_answers : 0;

      if (used === MICRO_STEPS && recAfter.micro_stage === "active") {
        setAccess(contactId, { micro_stage: "await_final" });
        await sendpulseTelegramSendText({ contactId, text: MICRO_FINAL_QUESTION_TEXT });
        return;
      }

      if (used >= MICRO_TOTAL_ANSWERS && recAfter.micro_stage === "await_final") {
        setAccess(contactId, {
          micro_stage: "idle",
          micro_active_until: null,
          micro_started_at: null,
          paywall_shown: true,
          paywall_hold_notified: false,
        });

        // ✅ запускаем repeat-воронку
        // ВАЖНО: она сама решит, показывать ли BASIC/UNLIMITED,
        // по переменной MICRO_CYCLE_COUNT, которую мы записываем при оплате.
        await startRepeatPayFlow(contactId);
        return;
      }
    }
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
