// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";

import { setTgMap, getContactIdByTgId } from "../access/tg-map-store.js";

// путь как у тебя сейчас
import { getHistory, pushToHistory, clearHistory } from "../src/memory/memory-store.js";

import {
  checkAndConsumeQuota,
  getAccess,
  setAccess,
  markUnlimitedUpsellShown,
  deleteAccess,
} from "../access/access-store.js";

// ---------- helpers ----------
function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : (payload ?? {});
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

// ---------- TEXTS ----------

// оффер после 2-го ответа и дальше
const OFFER_AFTER_2_TEXT = [
  "Сейчас ты снова реагируешь так же, как и раньше, как и до этого, и всегда в твоей жизни.",
  "И именно это уже приводило тебя к результату, который тебе не нравился.",
  "",
  "Ты можешь менять людей в своей жизни.",
  "Можешь менять обстоятельства, но все мы знаем такое выражение: «от себя не убежишь».",
  "",
  "Но если не изменить то, как ты реагируешь в каждой ситуации — всё повторится ⚠️",
  "Твой сценарий всегда включается автоматически, и он управляет тобой, а не ты им.",
  "И в какой-то момент ты снова оказываешься в той же точке.",
  "",
  "Я вижу, где именно начинается этот сбой.",
  "Но дальше нужен полный разбор.",
  "",
  "Ты продолжишь разговор со мной и получишь подробный разбор своей ситуации + PDF с описанием твоего типа 📘👇",
  "",
].join("\n");

// твой 95
const BASIC_95_WARN_TEXT = [
  "Мы подходим к завершению этого разговора 🔚",
  "",
  "Я хочу собрать главное 🧩",
  "и зафиксировать то,",
  "что для тебя сейчас ключевое ✨",
  "",
  "💬 Для более продуктивного завершения диалога напиши в бот ответы на вопросы:",
  "",
  "1️⃣ Что из этого разговора для тебя сейчас самое важное? 🧩",
  "",
  "2️⃣ Что стало яснее или встало на своё место? ✨",
  "",
  "3️⃣ Если ты вернёшься к разговору позже — про что он будет? 🔁💭",
  "",
  "4️⃣ В каком состоянии ты сейчас по сравнению с началом? 🌊",
  "",
  "5️⃣ Если собрать всё в одну фразу — что ты понял(а)? 💬",
].join("\n");

// твой 100
const BASIC_100_END_TEXT = [
  "Мы завершили этот разговор 😌",
  "",
  "Если ты захочешь разобрать другую тему или пойти глубже — можно начать новый диалог 💬✨",
].join("\n");

// жёсткий апселл на безлимит
const UNLIMITED_HARD_UPSELL_TEXT = [
  "😈 Окей, давай честно.",
  "Ты дошёл(а) до 100 сообщений — это значит, ты уже не «просто попробовал(а)».",
  "Ты реально работаешь со своей жизнью.",
  "",
  "И вот здесь люди обычно делают самую дорогую ошибку:",
  "закрывают диалог «на потом»…",
  "и через неделю снова оказываются в той же точке. ⚠️",
  "",
  "Безлимит — это когда ты не терпишь и не копишь,",
  "а разбираешь всё по факту появления:",
  "отношения, деньги, выбор, тревогу, провалы, разговоры, границы.",
  "",
  "Хочешь выйти из сценария — не делай паузу.",
  "Открывай безлимит и добивай до результата. 💥",
].join("\n");

// ---------- PAY LINKS ----------
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

async function sendOfferWithPayLink(req, contactId) {
  const { basic } = getPayLinks(req, contactId);
  if (!basic) {
    await sendpulseTelegramSendText({
      contactId,
      text:
        OFFER_AFTER_2_TEXT +
        "\n\n" +
        "⚠️ Не могу построить ссылку оплаты.\nПроверь переменную PUBLIC_BASE_URL и роут /pay/basic",
    });
    return;
  }

  const out = `${OFFER_AFTER_2_TEXT}\n\n👉 <a href="${basic}">Получить полный разбор — 1490 ₽</a>`;
  await sendpulseTelegramSendText({ contactId, text: out });
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

// ---------- ADMIN: выдача доступа (по tgId) ----------
async function grantPlanToContact({ contactId, plan, days = 30 }) {
  const paid_until = addDaysISO(days);

  setAccess(contactId, {
    plan,
    paid_until,
    last_reset_date: todayStr(),
    daily_used: 0,

    // снимаем режим оффера/блокировки
    paywall_shown: false,
    paywall_hold_notified: false,
    paywall_pause_due_at: null,
    paywall_pause_sent: false,
    paywall_pitch_due_at: null,
    paywall_pitch_sent: false,

    // счётчик ответов бота
    bot_answers_count: 0,

    // basic counters
    dialog_used: 0,
    dialog_warn95_sent: false,
    dialog_end100_sent: false,

    // unlimited upsell flags
    unlimited_upsell_shown: false,
    unlimited_nudge_due_at: null,
    unlimited_nudge_sent: false,
  });

  try {
    clearHistory(contactId);
  } catch {}

  return { ok: true, plan, paid_until };
}

// ---------- main ----------
export async function handleSendpulseWebhook(req, res) {
  // SendPulse нужно быстрое 200 OK
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = safeStr(extractText(event));
    const contactId = extractContactId(event);
    if (!contactId || !text) return;

    // tgId -> contactId (для Tribute/админ-выдачи)
    const tgId = extractTelegramUserId(event);
    if (tgId) {
      try {
        setTgMap(String(tgId), String(contactId));
      } catch (e) {
        console.error("setTgMap error:", e);
      }
    }

    const lower = text.toLowerCase();

    // /start
    if (lower === "/start") {
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет🙂 Напиши вопрос — и я отвечу.",
      });
      return;
    }

    // ---------- ADMIN: ids ----------
    if (lower === "/whoami") {
      const myTgId = extractTelegramUserId(event);
      await sendpulseTelegramSendText({
        contactId,
        text: `tgId: <b>${safeStr(myTgId) || "?"}</b>\ncontactId: <b>${safeStr(contactId)}</b>`,
      });
      return;
    }

    // ---------- ADMIN: тест прогресса BASIC ----------
    // /set_basic_progress 94
    if (lower.startsWith("/set_basic_progress")) {
      if (!isAdmin(event)) {
        await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
        return;
      }

      const parts = text.trim().split(/\s+/);
      const n = Number(parts[1] ?? 0);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        await sendpulseTelegramSendText({
          contactId,
          text: "Формат: /set_basic_progress <0..100>\nПример: /set_basic_progress 94",
        });
        return;
      }

      const paid_until = addDaysISO(30);

      setAccess(contactId, {
        plan: "basic",
        paid_until,
        daily_used: 0,
        last_reset_date: todayStr(),

        dialog_used: n,
        dialog_warn95_sent: n >= 95,
        dialog_end100_sent: n >= 100,

        paywall_shown: false,
        paywall_hold_notified: false,

        paywall_pause_due_at: null,
        paywall_pause_sent: false,
        paywall_pitch_due_at: null,
        paywall_pitch_sent: false,

        unlimited_upsell_shown: false,
        unlimited_nudge_due_at: null,
        unlimited_nudge_sent: false,

        bot_answers_count: 0,
      });

      try {
        clearHistory(contactId);
      } catch {}

      await sendpulseTelegramSendText({
        contactId,
        text:
          `✅ BASIC (тест) активирован\n` +
          `dialog_used = <b>${n}</b>\n` +
          `до: <b>${fmtIsoRu(paid_until)}</b>\n\n` +
          `Теперь напиши 1 сообщение — и увидишь поведение для ${n + 1}-го.`,
      });
      return;
    }

    // ---------- ADMIN: выдача доступа по tgId ----------
    // /grant_basic <tgId> [days]
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
        text: `✅ Выдан BASIC\ncontactId=${targetContactId}\npaid_until=${r.paid_until}`,
      });

      await sendpulseTelegramSendText({
        contactId: targetContactId,
        text: `✅ Доступ <b>BASIC</b> активирован до: <b>${fmtIsoRu(r.paid_until)}</b>`,
      });

      return;
    }

    // /grant_unlimited <tgId> [days]
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
        text: `✅ Выдан UNLIMITED\ncontactId=${targetContactId}\npaid_until=${r.paid_until}`,
      });

      await sendpulseTelegramSendText({
        contactId: targetContactId,
        text: `✅ Доступ <b>UNLIMITED</b> активирован до: <b>${fmtIsoRu(r.paid_until)}</b>`,
      });

      return;
    }

    // /revoke <tgId>
    if (lower.startsWith("/revoke")) {
      if (!isAdmin(event)) {
        await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
        return;
      }

      const parts = text.trim().split(/\s+/);
      const targetTgId = parts[1] ? String(parts[1]).trim() : "";
      if (!targetTgId) {
        await sendpulseTelegramSendText({ contactId, text: "Формат: /revoke <tgId>" });
        return;
      }

      const targetContactId = String(getContactIdByTgId(String(targetTgId)) || "").trim();
      if (!targetContactId) {
        await sendpulseTelegramSendText({ contactId, text: `Не найден contactId по tgId=${targetTgId}` });
        return;
      }

      setAccess(targetContactId, {
        plan: null,
        paid_until: null,
        daily_used: 0,
        dialog_used: 0,
        bot_answers_count: 0,
        paywall_shown: false,
        paywall_hold_notified: false,
        dialog_warn95_sent: false,
        dialog_end100_sent: false,
      });

      try {
        clearHistory(targetContactId);
      } catch {}

      await sendpulseTelegramSendText({ contactId, text: `✅ Доступ снят у contactId=${targetContactId}` });
      await sendpulseTelegramSendText({ contactId: targetContactId, text: `⛔ Доступ отключён.` });
      return;
    }

// 🔐 /reset только для админа — сброс "как новый"
if (lower === "/reset") {
  if (!isAdmin(event)) {
    await sendpulseTelegramSendText({ contactId, text: "⛔ Команда недоступна" });
    return;
  }

  try { clearHistory(contactId); } catch {}
  deleteAccess(contactId);

  await sendpulseTelegramSendText({
    contactId,
    text: "✅ Полный сброс сделан. Теперь ты как новый пользователь.",
  });
  return;
}

    // /pay — показать ссылку
    if (lower === "оплата" || lower === "/pay") {
      await sendOfferWithPayLink(req, contactId);
      return;
    }

    // -------- OFFER MODE: после 2-го ответа и дальше — всегда оффер, пока не оплатил --------
    const rec0 = getAccess(contactId) || {};
    const hasPaid0 = Boolean(rec0.paid_until);
    const botAnswers0 = Number.isFinite(rec0.bot_answers_count) ? rec0.bot_answers_count : 0;

 if (!hasPaid0 && botAnswers0 >= 2) {
  await sendOfferWithPayLink(req, contactId);
  return;
}

    // -------- limits BEFORE GPT --------
    const gate = checkAndConsumeQuota(contactId);

    // если BASIC/unlimited активны — пропускаем
    // если нет доступа/лимит — продаем оффером
    if (!gate.ok) {
      await sendOfferWithPayLink(req, contactId);
      return;
    }

    // -------- memory --------
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // -------- profile --------
    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);
    const profile = { main_sign: main_sign || "БАРСУК", active_signs };

    // -------- partner parsing --------
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // -------- GPT --------
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

    const answer = safeStr(result?.answer) || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";
    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({ contactId, text: out });
    pushToHistory(contactId, "assistant", answer);

    // ✅ Доп. сообщения по тарифам (BASIC 95/100)
    if (gate?.extra === "warn95" && gate?.notify) {
      await sendpulseTelegramSendText({ contactId, text: BASIC_95_WARN_TEXT });
    }

    if (gate?.extra === "end100" && gate?.notify) {
      // 1) завершение
      await sendpulseTelegramSendText({ contactId, text: BASIC_100_END_TEXT });

      // 2) жёсткий апселл + ссылка на безлимит (2990)
      await sendUnlimitedUpsellWithLink(req, contactId, UNLIMITED_HARD_UPSELL_TEXT);

      // 3) флаг (если нужно для аналитики/следующих сценариев)
      try {
        markUnlimitedUpsellShown(contactId);
      } catch {}
    }

    // -------- after-send triggers (для offer after 2) --------
    const rec = getAccess(contactId) || {};
    const botAnswers = Number.isFinite(rec.bot_answers_count) ? rec.bot_answers_count : 0;
    const newBotAnswers = botAnswers + 1;
    setAccess(contactId, { bot_answers_count: newBotAnswers });

    const hasPaid = Boolean(rec.paid_until);

    // После 2-го ответа — отправляем оффер ОДИН раз и включаем режим повторения
    if (!hasPaid && newBotAnswers === 2 && !rec.paywall_shown) {
      await sendOfferWithPayLink(req, contactId);
      setAccess(contactId, { paywall_shown: true });
      return;
    }
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
    try {
      const event = getEvent(req.body);
      const contactId2 = extractContactId(event);
      if (contactId2) {
        await sendpulseTelegramSendText({
          contactId: contactId2,
          text: "Упс, что-то пошло не так. Попробуй повторить 🙏",
        });
      }
    } catch {}
  }
}
