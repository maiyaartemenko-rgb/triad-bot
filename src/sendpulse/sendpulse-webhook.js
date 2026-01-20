// src/sendpulse/sendpulse-webhook.js
import { triadChat } from "../triad/triad-openai.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";
import { parsePartnerFromTextV4 } from "../parsing/parsePartnerFromText.v4.js";

// SendPulse присылает массив событий. Берём первое.
function getEvent(payload) {
  return Array.isArray(payload) ? (payload[0] || {}) : (payload || {});
}

function extractText(event) {
  return (
    event?.info?.message?.channel_data?.message?.text ??
    event?.contact?.last_message ??
    ""
  );
}

function extractContactId(event) {
  // В SendPulse это обычно contact.id (строка типа "68ee...")
  return event?.contact?.id ?? null;
}

function normalizeMainSignFromVars(vars) {
  // vars.Animal у тебя типа "🦡 Барсук"
  const raw = vars?.Animal || "";
  return String(raw)
    .replace(/[^\p{L}\s-]/gu, "")
    .trim()
    .toUpperCase();
}

function parseActiveSigns(vars) {
  // vars.active_signs: строка JSON вида:
  // [{"sign":"БАРСУК","pct":4}, ...]
  const raw = vars?.active_signs || "";
  if (!raw) return [];

  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];

    return arr
      .map(x => ({
        sign: String(x?.sign || "").trim().toUpperCase(),
        pct: Number(x?.pct ?? 0)
      }))
      .filter(x => x.sign && Number.isFinite(x.pct));
  } catch (err) {
    console.error("Bad active_signs JSON:", err);
    return [];
  }
}

// Универсально вытаскиваем "значение знака" из того, что вернул парсер
function toSignString(x) {
  if (!x) return null;

  if (typeof x === "string") return x;

  if (Array.isArray(x)) {
    for (const item of x) {
      const v = toSignString(item);
      if (v) return v;
    }
    return null;
  }

  if (typeof x === "object") {
    // ВАЖНО: тут должны быть ||
    return toSignString(x.sign || x.partnerSign || x.value || x.name || x.text);
  }

  return null;
}

// На всякий случай приводим к точному названию знака (если вдруг пришла фраза)
function normalizeSignWord(s) {
  if (!s) return null;

  const cleaned = String(s)
    .replace(/[^\p{L}\s-]/gu, "")
    .trim()
    .toUpperCase();

  const known = [
    "ДРАКОН","СКОРПИОН","ФЕНИКС","ВОЛК","ПОПУГАЙ",
    "БАРСУК","ТЮЛЕНЬ","ОСЬМИНОГ","БОБЕР"
    // + остальные знаки
  ];

  for (const k of known) {
    if (cleaned.includes(k)) return k;
  }

  // ❗ КЛЮЧЕВОЕ ИЗМЕНЕНИЕ
  return null;
}

function decodeHtmlEntities(s = "") {
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

export async function handleSendpulseWebhook(req, res) {
  // всегда быстро отвечаем OK
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);

    // работаем только с incoming_message
    if (event?.title !== "incoming_message") return;

    const text = String(extractText(event) || "").trim();
    const contactId = extractContactId(event);

    if (!text) return;
    if (!contactId) {
      console.error("No contactId in webhook payload");
      return;
    }

    // /start
    if (text.toLowerCase() === "/start") {
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет! Напиши вопрос — и я отвечу по твоему профилю 🙂"
      });
      return;
    }

    const vars = event?.contact?.variables || {};
    const main_sign = normalizeMainSignFromVars(vars) || null;
    const active_signs = parseActiveSigns(vars);

    const profile = {
      main_sign: main_sign || "БАРСУК",
      active_signs
    };

  // 1. Парсим партнёра из текста
const partnerParsed = parsePartnerFromTextV4(text);

// 2. Приводим к строке знака
const partnerSign = normalizeSignWord(toSignString(partnerParsed));

// fallback: если парсер не понял знак — попробуем вытащить прямо из текста
let finalPartnerSign = partnerSign;
if (!finalPartnerSign) finalPartnerSign = normalizeSignWord(text);

const result = await triadChat({
  userText: text,
  profile,
  partnerSign: finalPartnerSign,
  model: process.env.OPENAI_MODEL || "gpt-5.2",
  temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6)
});

    const answer = result?.answer?.trim() || "Я рядом. Сформулируй вопрос чуть конкретнее 🙂";
    const html = decodeHtmlEntities(answer);

    await sendpulseTelegramSendText({
      contactId,
      text: html
    });
  } catch (err) {
    console.error("SENDPULSE_WEBHOOK_ERROR:", err);
  }
}