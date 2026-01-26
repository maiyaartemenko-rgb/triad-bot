// src/sendpulse/sendpulse-webhook.js

import { triadChat } from "../triad/triad-openai.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";

import { sendpulseTelegramSendText } from "./sendpulse-api.js";

// ✅ правильный путь (файл: src/memory/memory-store.js)
import { getHistory, pushToHistory, clearHistory } from "../memory/memory-store.js";

import { checkAndConsumeQuota } from "../access/access-store.js";

// ---------- helpers ----------
function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] ?? {}) : (payload ?? {});
}

function extractText(event) {
  return (
    event?.info?.message?.channel_data?.message?.text ??
    event?.contact?.last_message ??
    ""
  );
}

function extractContactId(event) {
  // ✅ самый стабильный ID для платежей/лимитов
  return event?.contact?.id ?? null;
}

function normalizeMainSignFromVars(vars) {
  // поддержим разные варианты имени переменной
  const raw = vars?.Animal || vars?.animal || "";
  return String(raw)
    .replace(/[^\p{L}\s-]/gu, "") // убираем эмодзи/мусор
    .trim()
    .toUpperCase();
}

function parseActiveSigns(vars) {
  const raw = vars?.active_signs || "";
  if (!raw) return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        sign: String(x?.sign || "").trim().toUpperCase(),
        pct: Number(x?.pct ?? 0),
      }))
      .filter((x) => x.sign && Number.isFinite(x.pct));
  } catch (err) {
    console.error("Bad active_signs JSON:", err);
    return [];
  }
}

function decodeHtmlEntities(s = "") {
  // иногда модель может вернуть &lt;b&gt;
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

// ---------- PAYWALL ----------
function buildPaywallText({ gate }) {
  // gate.reason может прийти (если ты добавишь позже). Пока поддержим и без него.
  const isTrialEnded = gate?.reason === "trial_ended";

  const top = isTrialEnded
    ? "⛔ <b>Бесплатный период завершён.</b>"
    : "⛔ <b>Дневной лимит вопросов исчерпан.</b>";

  const line2 = isTrialEnded
    ? "Чтобы продолжить — оформи подписку ниже 👇"
    : "Завтра снова будут доступны 3 вопроса бесплатно 👇";

  return [top, line2, "", "<b>Доступы:</b>"].join("\n");
}

function getPayLinks(contactId) {
  const basicBase = process.env.TRIBUTE_BASIC_URL || "";
  const unlimitedBase = process.env.TRIBUTE_UNLIMITED_URL || "";

  if (!basicBase || !unlimitedBase) {
    return { basic: null, unlimited: null };
  }

  // Вшиваем contactId в startapp, чтобы Tribute вернул его в webhook
  function withContactId(url) {
    return url.replace(
      /startapp=([^&]+)/,
      (m, code) => `startapp=${code}__cid__${encodeURIComponent(contactId)}`
    );
  }

  return {
    basic: withContactId(basicBase),
    unlimited: withContactId(unlimitedBase),
  };
}

async function sendPaywall(contactId, gate) {
  const { basic, unlimited } = getPayLinks(contactId);

  // если вдруг забыли переменные — покажем явную ошибку
  if (!basic || !unlimited) {
    await sendpulseTelegramSendText({
      contactId,
      text:
        "⛔ Лимит исчерпан.\n\n" +
        "⚠️ Ссылки оплаты не настроены.\n" +
        "Проверь переменные Render:\n" +
        "TRIBUTE_BASIC_URL и TRIBUTE_UNLIMITED_URL",
    });
    return;
  }

  const header = buildPaywallText({ gate });

  // ✅ HTML (parse_mode у тебя включён в sendpulse-api)
  const text = [
    header,
    `• 900 ₽ — 3 вопроса в день: <a href="${basic}">Оплатить</a>`,
    `• 2900 ₽ — безлимит: <a href="${unlimited}">Оплатить</a>`,
    "",
    "❗ Если при оплате появится поле <b>«Детали заказа»</b> —",
    "впиши туда любое слово (например: <i>ок</i>). Это техническое поле.",
  ].join("\n");

  await sendpulseTelegramSendText({ contactId, text });
}

// ---------- main ----------
export async function handleSendpulseWebhook(req, res) {
  // SendPulse нужно быстрое 200 OK
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);
    if (event?.title !== "incoming_message") return;

    const text = String(extractText(event) || "").trim();
    const contactId = extractContactId(event);

    if (!contactId) {
      console.error("No contactId in webhook payload");
      return;
    }
    if (!text) return;

    const lower = text.toLowerCase();

    // -------- commands --------
    if (lower === "/start") {
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет! Напиши вопрос — и я отвечу 🙂",
      });
      return;
    }

    if (lower === "/reset") {
      clearHistory(contactId);
      await sendpulseTelegramSendText({
        contactId,
        text: "Ок, очистила контекст 🧼",
      });
      return;
    }

    // "оплата" — показываем ссылки без расхода лимита
    if (lower === "оплата" || lower === "/pay") {
      await sendPaywall(contactId, { reason: "trial_ended" });
      return;
    }

    // -------- limits BEFORE GPT --------
    const gate = checkAndConsumeQuota(contactId);
    if (!gate.ok) {
      await sendPaywall(contactId, gate);
      return;
    }

    // -------- memory --------
    pushToHistory(contactId, "user", text);
    const history = getHistory(contactId, 10);

    // -------- profile from SendPulse vars --------
    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);

    const profile = {
      main_sign: main_sign || "БАРСУК",
      active_signs,
    };

    // -------- partner parsing --------
    const parsed = parsePartnerFromTextV4(text);
    const partnerSign = parsed?.partnerSign || null;

    // -------- GPT --------
    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
      history,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6),
    });

    const answer =
      result?.answer?.trim() || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";

    const out = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({
      contactId,
      text: out,
    });

    pushToHistory(contactId, "assistant", answer);

    console.log(
      "quota:",
      gate.plan,
      "left:",
      gate.left,
      "partnerSign:",
      partnerSign,
      "confidence:",
      parsed?.confidence
    );
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}

