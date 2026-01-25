// src/sendpulse/sendpulse-api.js
import fetch from "node-fetch";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;

  const client_id = process.env.SENDPULSE_CLIENT_ID;
  const client_secret = process.env.SENDPULSE_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error("Missing SENDPULSE_CLIENT_ID or SENDPULSE_CLIENT_SECRET in env");
  }

  const resp = await fetch("https://api.sendpulse.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id,
      client_secret
    })
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.access_token) {
    throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  return cachedToken;
}

/**
 * Отправка текста (и кнопок) в Telegram через SendPulse.
 * buttons: [{ text: "BASIC 999₽", url: "https://..." }, ...]
 */
export async function sendpulseTelegramSendText({ contactId, text, buttons = null }) {
  const token = await getAccessToken();

  const payload = {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML"
    }
  };

  // ✅ Inline-кнопки Telegram
  if (Array.isArray(buttons) && buttons.length) {
    payload.message.reply_markup = {
      inline_keyboard: buttons.map((b) => [
        { text: String(b.text ?? "Открыть"), url: String(b.url ?? "") }
      ])
    };
  }

  const resp = await fetch("https://api.sendpulse.com/telegram/contacts/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse send error ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data;
}