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

// первая воронка оплаты (после исчерпания бесплатных 2 ответов в день / или после free-window)
const SP_PAY_16_STARS_FLOW_ID = String(process.env.SP_PAY_16_STARS_FLOW_ID || "").trim();

// повторная воронка (после завершения micro-цикла)
const SP_PAY_16_STARS_REPEAT_FLOW_ID = String(process.env.SP_PAY_16_STARS_REPEAT_FLOW_ID || "").trim();

// переменная SendPulse, которую выставляет воронка после оплаты (значение 1/true)
const SP_PAID_FLAG_VAR = String(process.env.SP_MICRO_PAID_VAR || "PAID_16_STARS_12_STEPS").trim();

// переменная SendPulse, куда сервер пишет количество циклов (для ветвления repeat-воронки)
const SP_MICRO_CYCLE_COUNT_VAR = String(
  process.env.SP_MICRO_CYCLE_COUNT_VAR || "micro_cycle_count"
).trim();

// micro config (согласовано по смыслу с access-store)
const MICRO_STEPS = 12;
const MICRO_TOTAL_ANSWERS = 13;

// команды меню, на которые бот НЕ должен отвечать и НЕ должен тратить лимит
const IGNORED_MENU_COMMANDS = new Set([
  "/start",
  "/redkost",
  "/moyznak",
  "/opisanie",
  "/channel",
  "/basic",
  "/unlimited",
  "/vseznaki",
  "/help",
  "/dengi",
  "/sila",
  "/sovmestimost",
]);

// ==================== HELPERS ====================

function getEvent(payload) {
  return Array.isArray(payload) ? payload[0] ?? {} : payload ?? {};
}

function safeStr(x) {
  return String(x ?? "").trim();
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
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

// ==================== TEXTS (серверные только там, где надо) ====================

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

// BASIC 95/100
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

// ==================== TRIBUTE LINKS (для безлимита) ====================

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

// ==================== FLOWS ====================

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
  const fid = SP_PAY_16_STARS_REPEAT_FLOW_ID || SP_PAY_16_STARS_FLOW_ID;
  return startFlowSafe({ flowId: fid, contactId });
}

// ==================== MICRO: activate by paid flag ====================

async function tryActivateMicroFromSendPulseFlag({ contactId, vars }) {
  const paidFlag = isTruthyFlagValue(vars?.[SP_PAID_FLAG_VAR]);
  if (!paidFlag) return { ok: false, reason: "no_flag" };

  const rec = getAccess(contactId) || {};

  // уже активен — сбрасываем флаг (чтобы не залипло)
  if (isMicroActive(rec)) {
    try {
      await sendpulseSetContactVariables({ contactId, variables: { [SP_PAID_FLAG_VAR]: "0" } });
    } catch {}
    return { ok: true, already: true };
  }

  const cycleCount = Number.isFinite(rec.micro_cycle_count) ? rec.micro_cycle_count : 0;
  const nextCycle = cycleCount + 1;

  // Активируем micro
  setAccess(contactId, {
    micro_cycle_count: nextCycle,
    micro_active_until: new Date(Date.now() + 24 * 3600000).toISOString(),
    micro_started_at: new Date().toISOString(),
    micro_stage: "active",
    micro_used_answers: 0,

    // снимаем paywall
    paywall_shown: false,
    paywall_hold_notified: false,
    paywall_day: null,
  });

  // пишем счётчик циклов в SendPulse и сбрасываем флаг оплаты
  try {
    await sendpulseSetContactVariables({
      contactId,
      variables: {
        [SP_MICRO_CYCLE_COUNT_VAR]: String(nextCycle),
        [SP_PAID_FLAG_VAR]: "0",
      },
    });
  } catch (e) {
    console.error("sendpulseSetContactVariables (cycle) error:", e);
    try {
      await sendpulseSetContactVariables({ contactId, variables: { [SP_PAID_FLAG_VAR]: "0" } });
    } catch {}
  }

  return { ok: true, activated: true, cycle: nextCycle };
}

// ==================== ADMIN: выдача доступа ====================

async function grantPlanToContact({ contactId, plan, days = 30 }) {
  const paid_until = addDaysISO(days);

  setAccess(contactId, {
    plan,
    paid_until,
    last_reset_date: todayStr(),
    daily_used: 0,

    paywall_shown: false,
    paywall_hold_notified: false,
    paywall_day: null,

    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,
  });

  try {
    clearHistory(contactId);
  } catch {}

  return { ok: true, plan, paid_until };
}

// ==================== MAIN ====================

export async function handleSendpulseWebhook(req, res) {
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = safeStr(extractText(event));
    const contactId = extractContactId(event);
    if (!contactId || !text) return;

    // tgId -> contactId mapping (для админ-выдач)
    const tgId = extractTelegramUserId(event);
    if (tgId) {
      try {
        setTgMap(String(tgId), String(contactId));
      } catch (e) {
        console.error("setTgMap error:", e);
      }
    }

    const lower = text.toLowerCase();

    // vars from SendPulse contact
    const vars = event?.contact?.variables || {};

    // 1) если пришёл флаг оплаты — активируем micro
    try {
      await tryActivateMicroFromSendPulseFlag({ contactId, vars });
    } catch (e) {
      console.error("tryActivateMicroFromSendPulseFlag error:", e);
    }

    // 2) игнорируем команды меню полностью
    if (IGNORED_MENU_COMMANDS.has(lower)) {
      return;
    }

    // ---------- ADMIN ----------
    if (lower === "/whoami") {
      await sendpulseTelegramSendText({
        contactId,
        text: `tgId: <b>${safeStr(tgId) || "?"}</b>\ncontactId: <b>${safeStr(contactId)}</b>`,
      });
      return;
    }

    if (lower.startsWith("/grant_basic")) {
      if (!isAdmin(event)) {
        await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
        return;
      }

      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      const days = parts[2] ? Number(parts[2]) : 30;

      if (!targetTgId) {
        await sendpulseTelegramSendText({
          contactId,
          text: "Формат: /grant_basic <tgId> [days]\nПример: /grant_basic 123456789 30",
        });
        return;
      }

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) {
        await sendpulseTelegramSendText({
          contactId,
          text: `Не найден contactId по tgId=${targetTgId}.\nПусть пользователь напишет боту хотя бы 1 сообщение.`,
        });
        return;
      }

      const r = await grantPlanToContact({ contactId: targetContactId, plan: "basic", days });
      await sendpulseTelegramSendText({
        contactId,
        text: `✅ Выдан BASIC\ncontactId=${targetContactId}\npaid_until=${fmtIsoRu(r.paid_until)}`,
      });
      return;
    }

    if (lower.startsWith("/grant_unlimited")) {
      if (!isAdmin(event)) {
        await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
        return;
      }

      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      const days = parts[2] ? Number(parts[2]) : 30;

      if (!targetTgId) {
        await sendpulseTelegramSendText({
          contactId,
          text: "Формат: /grant_unlimited <tgId> [days]\nПример: /grant_unlimited 123456789 30",
        });
        return;
      }

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) {
        await sendpulseTelegramSendText({
          contactId,
          text: `Не найден contactId по tgId=${targetTgId}.\nПусть пользователь напишет боту хотя бы 1 сообщение.`,
        });
        return;
      }

      const r = await grantPlanToContact({ contactId: targetContactId, plan: "unlimited", days });
      await sendpulseTelegramSendText({
        contactId,
        text: `✅ Выдан UNLIMITED\ncontactId=${targetContactId}\npaid_until=${fmtIsoRu(r.paid_until)}`,
      });
      return;
    }

    if (lower === "/reset") {
      if (!isAdmin(event)) {
        await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
        return;
      }

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

    // ---------- LIMITS BEFORE GPT ----------
    // ВАЖНО: checkAndConsumeQuota вызывается ВСЕГДА.
    // Никакого раннего return по paywall_shown до него.
    const gate = checkAndConsumeQuota(contactId);

    if (!gate.ok) {
      const recX = getAccess(contactId) || {};
      const paidX = isPaidActive(recX);
      const microX = isMicroActive(recX);

      // если доступа нет — запускаем оплатную воронку (один раз за день/состояние)
      if (PAYWALL_BY_SENDPULSE && !paidX && !microX && !recX.paywall_shown) {
        setAccess(contactId, {
          paywall_shown: true,
          paywall_hold_notified: false,
        });
        await startPayFlow(contactId);
      }
      return;
    }

    // ---------- MEMORY ----------
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // ---------- PROFILE ----------
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = { main_sign: main_sign || "БАРСУК", active_signs };

    // ---------- PARTNER ----------
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // ---------- GPT ----------
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

    // ✅ BASIC 95/100
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

    // ✅ MICRO сервисные сообщения
    if (gate.plan === "micro") {
      if (gate.extra === "micro_pre_final" && gate.notify) {
        await sendpulseTelegramSendText({ contactId, text: MICRO_FINAL_QUESTION_TEXT });
        return;
      }

      if (gate.extra === "micro_end" && gate.notify) {
        setAccess(contactId, {
          paywall_shown: true,
          paywall_hold_notified: false,
        });
        await startRepeatPayFlow(contactId);
        return;
      }
    }
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
