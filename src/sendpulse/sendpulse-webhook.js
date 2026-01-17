// src/sendpulse/sendpulse-webhook.js
import { triadChat } from "../triad/triad-openai.js";
import { sendpulseTelegramSendText } from "./sendpulse-api.js";

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
  return (
    event?.contact?.id ??                     // <-- SendPulse contact id (самое правильное)
    event?.contact?.telegram_id ??            // иногда так
    event?.info?.message?.channel_data?.chat_id ?? // Telegram chat_id (если твой sendpulse-api шлёт по нему)
    null
  );
}

function normalizeMainSignFromVars(vars) {
  // vars.Animal у тебя типа "🦡 Барсук"
  const raw = vars?.Animal || "";
  return String(raw)
    .replace(/[^\p{L}\s-]/gu, "") // убираем эмодзи и знаки
    .trim()
    .toUpperCase();
}

export async function handleSendpulseWebhook(req, res) {
  // 1) всегда быстро отвечаем OK
  res.status(200).json({ ok: true });

  try {
    const event = getEvent(req.body);

    // защитимся: работаем только с incoming_message
    if (event?.title !== "incoming_message") return;

    const text = String(extractText(event) || "").trim();
    const contactId = extractContactId(event);

    if (!text) return;
    if (!contactId) {
      console.error("No contactId in webhook payload");
      return;
    }

    // /start можно игнорировать или отвечать коротко
    if (text.toLowerCase() === "/start") {
      await sendpulseTelegramSendText({
        contactId,
        text: "Привет! Напиши вопрос — и я отвечу по твоему профилю 🙂"
      });
      return;
    }

   const vars = event?.contact?.variables || {};
const main_sign = normalizeMainSignFromVars(vars) || null;

function parseActiveSigns(vars) {
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
    console.error("Bad active_signs JSON:", err, raw);
    return [];
  }
}

const active_signs = parseActiveSigns(vars);

const profile = {
  main_sign: main_sign || "БАРСУК",
  active_signs
};

    const result = await triadChat({
      userText: text,
      profile,
      partnerSign: null,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0.6)
    });

    function decodeHtmlEntities(s = "") {
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

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