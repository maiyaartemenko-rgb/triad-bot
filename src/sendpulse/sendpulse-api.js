// src/sendpulse/sendpulse-api.js
import dotenv from "dotenv";
dotenv.config();

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
      client_secret,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  return cachedToken;
}

async function spRequest(path, payload) {
  const token = await getAccessToken();

  const resp = await fetch(`https://api.sendpulse.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SendPulse API error ${resp.status} ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ✅ Обычное текстовое сообщение
export async function sendpulseTelegramSendText({ contactId, text }) {
  return spRequest("/telegram/contacts/send", {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
    },
  });
}

// ✅ Текст + inline-кнопки (URL)
export async function sendpulseTelegramSendButtons({ contactId, text, buttons }) {
  // buttons: [{ text: "Оплатить Basic", url: "https://..." }, ...]
  // Формат клавиатуры у SendPulse может отличаться — но этот вариант часто работает.
  return spRequest("/telegram/contacts/send", {
    contact_id: String(contactId),
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: (buttons || []).map((b) => [
          { text: String(b.text), url: String(b.url) },
        ]),
      },
    },
  });
}

/**
 * ✅ Запись переменных контакта в SendPulse
 * variables = { plan, paid_until, trial_started_at, daily_used, day }
 *
 * В разных аккаунтах SendPulse бывают разные endpoints.
 * Поэтому делаем "пуленепробиваемо":
 * 1) пробуем setVariables пачкой
 * 2) если не получилось — пробуем setVariable по одной
 */
export async function sendpulseSetContactVariables({ contactId, variables }) {
  const vars = variables || {};

  // 1) Попытка пачкой
  try {
    return await spRequest("/telegram/contacts/setVariables", {
      contact_id: String(contactId),
      variables: vars,
    });
  } catch (e1) {
    // 2) Фолбэк: по одной переменной
    const entries = Object.entries(vars);
    const results = [];
    for (const [name, value] of entries) {
      try {
        const r = await spRequest("/telegram/contacts/setVariable", {
          contact_id: String(contactId),
          variable: String(name),
          value: value == null ? "" : String(value),
        });
        results.push({ name, ok: true, r });
      } catch (e2) {
        results.push({ name, ok: false, error: String(e2?.message || e2) });
      }
    }
    // если вообще всё упало — кинем ошибку, чтобы было видно в логах
    const anyOk = results.some((x) => x.ok);
    if (!anyOk) {
      throw new Error(
        `SendPulse variables update failed. Tried setVariables + setVariable. Last errors: ${JSON.stringify(
          results,
          null,
          2
        )}`
      );
    }
    return { ok: true, partial: true, results };
  }
}
