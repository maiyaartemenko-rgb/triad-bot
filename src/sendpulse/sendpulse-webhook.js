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
const SP_PAY_16_STARS_FLOW_ID = String(process.env.SP_PAY_16_STARS_FLOW_ID || "").trim();

// ✅ имя переменной, которую ставит SendPulse после оплаты
const SP_PAID_FLAG_VAR = "PAID_16_STARS_12_STEPS";

// micro config (должно совпадать по смыслу с access-store)
const MICRO_WINDOW_HOURS = 24;
const MICRO_STEPS = 12; // 12 ответов
const MICRO_TOTAL_ANSWERS = 13; // 12 + финальный

// ==================== helpers ====================

function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : payload ?? {};
}

function safeStr(x) {
  return String(x ?? "").trim();
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
  return Number.isFinite(t) && Date.now() < t && (rec.micro_stage === "active" || rec.micro_stage === "await_final");
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

// BASIC 95/100 и upsell Tribute (оставляем как было)
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

// ==================== Tribute links (как было) ====================
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

// ==================== STARS FLOW TRIGGER ====================
async function triggerStarsFlowIfConfigured(contactId) {
  if (!PAYWALL_BY_SENDPULSE) return { ok: false, reason: "disabled" };
  if (!SP_PAY_16_STARS_FLOW_ID) {
    console.error("SP_PAY_16_STARS_FLOW_ID is empty. Flow won't start.");
    return { ok: false, reason: "no_flow_id" };
  }
  try {
    await sendpulseStartFlow({ flowId: SP_PAY_16_STARS_FLOW_ID, contactId });
    return { ok: true };
  } catch (e) {
    console.error("sendpulseStartFlow error:", e);
    return { ok: false, reason: "api_error" };
  }
}

// ==================== MICRO: activate if paid flag is set ====================
async function tryActivateMicroFromSendPulseFlag({ contactId, vars }) {
  const flagVal = safeStr(vars?.[SP_PAID_FLAG_VAR] ?? "");
  const isPaidFlag = flagVal === "1" || flagVal.toLowerCase() === "true" || flagVal.toLowerCase() === "yes";
  if (!isPaidFlag) return { ok: false, reason: "no_flag" };

  const rec = getAccess(contactId) || {};
  if (isMicroActive(rec)) {
    // уже активен — просто сбросим флаг на всякий
    try {
      await sendpulseSetContactVariables({ contactId, variables: { [SP_PAID_FLAG_VAR]: "0" } });
    } catch {}
    return { ok: true, already: true };
  }

  const cycleCount = Number.isFinite(rec.micro_cycle_count) ? rec.micro_cycle_count : 0;

  // ✅ активируем 24 часа и обнуляем счётчик микро-ответов
  setAccess(contactId, {
    micro_cycle_count: cycleCount + 1,
    micro_active_until: addHoursISO(MICRO_WINDOW_HOURS),
    micro_started_at: new Date().toISOString(),
    micro_stage: "active",
    micro_used_answers: 0,

    // выходим из paywall, чтобы GPT отвечал
    paywall_shown: false,
    paywall_hold_notified: false,
  });

  // ✅ очень важно: сбросить флаг оплаты в SendPulse
  await sendpulseSetContactVariables({ contactId, variables: { [SP_PAID_FLAG_VAR]: "0" } });

  return { ok: true, activated: true };
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
      try { setTgMap(String(tgId), String(contactId)); } catch (e) { console.error("setTgMap error:", e); }
    }

    const lower = text.toLowerCase();

    // /start — ничего не пишем
    if (lower === "/start") return;

    // vars from SendPulse contact
    const vars = event?.contact?.variables || {};

    // ✅ 1) если пришла оплата-флажок — включаем micro-доступ и СРАЗУ сбрасываем переменную
    try {
      await tryActivateMicroFromSendPulseFlag({ contactId, vars });
    } catch (e) {
      console.error("tryActivateMicroFromSendPulseFlag error:", e);
    }

    // ---------- ADMIN ----------
    if (lower === "/whoami") {
      const myTgId = extractTelegramUserId(event);
      await sendpulseTelegramSendText({
        contactId,
        text: `tgId: <b>${safeStr(myTgId) || "?"}</b>\ncontactId: <b>${safeStr(contactId)}</b>`,
      });
      return;
    }

    if (lower === "/reset") {
      if (!isAdmin(event)) return;
      try { clearHistory(contactId); } catch {}
      try { deleteAccess(contactId); } catch (e) { console.error("deleteAccess error:", e); }
      await sendpulseTelegramSendText({ contactId, text: "✅ Полный сброс сделан. Теперь ты как новый пользователь." });
      return;
    }

    // ---------- PAYWALL SILENCE ----------
    const rec0 = getAccess(contactId) || {};
    const paidActive0 = isPaidActive(rec0);
    const microActive0 = isMicroActive(rec0);

    // если micro активен — НЕ молчим
    if (PAYWALL_BY_SENDPULSE && !paidActive0 && !microActive0 && rec0.paywall_shown) return;

    // ---------- LIMITS BEFORE GPT ----------
    const gate = checkAndConsumeQuota(contactId);

    if (!gate.ok) {
      // если нет доступа и нет micro/платных — стартуем flow оплаты
      const recX = getAccess(contactId) || {};
      const paidX = isPaidActive(recX);
      const microX = isMicroActive(recX);

      if (PAYWALL_BY_SENDPULSE && !paidX && !microX && !recX.paywall_shown) {
        setAccess(contactId, { paywall_shown: true, paywall_hold_notified: false });
        await triggerStarsFlowIfConfigured(contactId);
      }
      return;
    }

    // ---------- memory ----------
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // ---------- profile ----------
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = { main_sign: main_sign || "БАРСУК", active_signs };

    // ---------- partner ----------
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
      await sendpulseTelegramSendText({ contactId, text: "Сейчас технический сбой. Попробуй ещё раз через минуту 🙏" });
      return;
    }

    const answer = safeStr(result?.answer) || "Ок. Сформулируй вопрос чуть конкретнее 🙂";
    await sendpulseTelegramSendText({ contactId, text: decodeHtmlEntities(answer) });
    pushToHistory(contactId, "assistant", answer);
    // ---------- after-send: count bot answers & trigger paywall after 2 ----------
{
  const rec = getAccess(contactId) || {};
  const paid = isPaidActive(rec);
  const micro = isMicroActive(rec);

  // считаем ответы только если нет платного плана и не активен micro-цикл
  if (!paid && !micro) {
    const prev = Number.isFinite(rec.bot_answers_count) ? rec.bot_answers_count : 0;
    const next = prev + 1;

    setAccess(contactId, { bot_answers_count: next });

    // ✅ после 2-го ответа — запускаем flow и включаем режим paywall
    if (next >= 2 && !rec.paywall_shown) {
      setAccess(contactId, { paywall_shown: true, paywall_hold_notified: false });

      // запускаем SendPulse-воронку с оплатой (в ней твой текст + кнопка)
      await triggerStarsFlowIfConfigured(contactId);

      // дальше: сервер уже будет молчать, потому что paywall_shown=true
      // (следующее сообщение пользователя не получит GPT-ответ, пока не оплатит)
    }
  }
}


    // ✅ BASIC 95/100
    if (gate?.extra === "warn95" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_95_WARN_TEXT });
    }
    if (gate?.extra === "end100" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_100_END_TEXT });
      await sendUnlimitedUpsellWithLink(req, contactId, UNLIMITED_HARD_UPSELL_TEXT);
      try { markUnlimitedUpsellShown(contactId); } catch {}
    }

    // ---------- MICRO финализация ----------
    const recAfter = getAccess(contactId) || {};
    if (gate.plan === "micro" && isMicroActive(recAfter)) {
      const used = Number.isFinite(recAfter.micro_used_answers) ? recAfter.micro_used_answers : 0;

      // used считается в access-store: уже +1 на этот ответ
      if (used === MICRO_STEPS && recAfter.micro_stage === "active") {
        // после 12-го ответа — отправляем финальный вопрос и ждём ответ пользователя
        setAccess(contactId, { micro_stage: "await_final" });
        await sendpulseTelegramSendText({ contactId, text: MICRO_FINAL_QUESTION_TEXT });
        return;
      }

      if (used >= MICRO_TOTAL_ANSWERS && recAfter.micro_stage === "await_final") {
        // выдали финальный ответ (13-й) — закрываем цикл и сразу запускаем оплату следующего
        setAccess(contactId, {
          micro_stage: "idle",
          micro_active_until: null,
          micro_started_at: null,
          paywall_shown: true,
          paywall_hold_notified: false,
        });

        await triggerStarsFlowIfConfigured(contactId);
        return;
      }
    }

  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}
