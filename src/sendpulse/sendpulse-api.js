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
    throw new Error("Missing SENDPULSE_CLIENT_ID or SENDPULSE_CLIENT_SECRET");
  }

  const resp = await fetch("https://api.sendpulse.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id,
      client_secret,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

// ---------- ТЕКСТ ----------
export async function sendpulseTelegramSendText({ contactId, text }) {
  const token = await getAccessToken();

  const resp = await fetch(
    "https://api.sendpulse.com/telegram/contacts/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        contact_id: String(contactId),
        message: {
          type: "text",
          text,
          parse_mode: "HTML",
        },
      }),
    }
  );

  if (!resp.ok) {
    const data = await resp.text();
    throw new Error(`SendPulse send error ${resp.status}: ${data}`);
  }
}

// ---------- КНОПКИ ----------
export async function sendpulseTelegramSendButtons({ contactId, text, buttons }) {
  const token = await getAccessToken();

  const resp = await fetch(
    "https://api.sendpulse.com/telegram/contacts/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        contact_id: String(contactId),
        message: {
          type: "inline_keyboard",
          text,
          inline_keyboard: buttons,
          parse_mode: "HTML",
        },
      }),
    }
  );

  if (!resp.ok) {
    const data = await resp.text();
    throw new Error(`SendPulse buttons error ${resp.status}: ${data}`);
  }
}

// ---------- ПЕРЕМЕННЫЕ ----------
export async function sendpulseSetContactVariables({ contactId, variables }) {
  const token = await getAccessToken();

  const resp = await fetch(
    "https://api.sendpulse.com/telegram/contacts/setVariable",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        contact_id: String(contactId),
        variables,
      }),
    }
  );

  if (!resp.ok) {
    const data = await resp.text();
    throw new Error(`SendPulse setVariable error ${resp.status}: ${data}`);
  }
}
