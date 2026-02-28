// src/sendpulse/sendpulse-api.js
import dotenv from "dotenv";
dotenv.config();

const SP_BASE = "https://api.sendpulse.com";

let cachedToken = null;
let tokenExpiresAt = 0;

// -------------------- low-level helpers --------------------

function assertEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing ${name} in env`);
  return v;
}

function safeJsonParse(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _non_json: raw };
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getAccessToken(force = false) {
  const now = Date.now();
  if (!force && cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;

  const client_id = assertEnv("SENDPULSE_CLIENT_ID");
  const client_secret = assertEnv("SENDPULSE_CLIENT_SECRET");

  const resp = await fetchWithTimeout(
    `${SP_BASE}/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id,
        client_secret,
      }),
    },
    15000
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`SendPulse token error ${resp.status}: ${JSON.stringify(data)}`);

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

async function spRequest(method, path, payload, { timeoutMs = 20000, retry401 = true } = {}) {
  const token = await getAccessToken(false);

  const resp = await fetchWithTimeout(
    `${SP_BASE}${path}`,
    {
      method: String(method || "POST").toUpperCase(),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload ?? {}),
    },
    timeoutMs
  );

  // если токен протух — обновляем и повторяем 1 раз
  if (resp.status === 401 && retry401) {
    await getAccessToken(true);
    return spRequest(method, path, payload, { timeoutMs, retry401: false });
  }

  const raw = await resp.text().catch(() => "");
  const data = safeJsonParse(raw);

  if (!resp.ok) {
    const err = new Error(`SendPulse API error ${resp.status} ${path}: ${JSON.stringify(data)}`);
    err._sp = { status: resp.status, path, data };
    throw err;
  }

  return data;
}

/**
 * Пробуем несколько POST-эндпоинтов/пейлоадов для одной логики (flow, variables и т.п.)
 * Возвращаем первый успешный.
 */
async function tryVariants({ endpoints, payloads, timeoutMs = 20000 }) {
  let lastErr = null;
  for (const path of endpoints) {
    for (const payload of payloads) {
      try {
        const result = await spRequest("POST", path, payload, { timeoutMs });
        return { ok: true, path, payloadUsed: payload, result };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("SendPulse API: all variants failed");
}

// -------------------- public API --------------------

// ✅ Обычное текстовое сообщение (HTML)
export async function sendpulseTelegramSendText({ contactId, text }) {
  const cid = String(contactId || "").trim();
  if (!cid) throw new Error("sendpulseTelegramSendText: missing contactId");

  return spRequest("POST", "/telegram/contacts/send", {
    contact_id: cid,
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  });
}

// ✅ Текст + inline-кнопки (URL)
export async function sendpulseTelegramSendButtons({ contactId, text, buttons }) {
  const cid = String(contactId || "").trim();
  if (!cid) throw new Error("sendpulseTelegramSendButtons: missing contactId");

  const items = (buttons || [])
    .filter((b) => b?.text && b?.url)
    .map((b) => ({ text: String(b.text), url: String(b.url) }));

  return spRequest("POST", "/telegram/contacts/send", {
    contact_id: cid,
    message: {
      type: "text",
      text: String(text ?? ""),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: items.map((b) => [b]),
      },
      // fallback (иногда SendPulse принимает так)
      buttons: items,
    },
  });
}

/**
 * ✅ Запись переменных контакта в SendPulse
 * Важно: этот метод иногда капризный — поэтому есть 3 стратегии (batch array / batch object / one-by-one).
 *
 * Если тебе нужно “пауза на минуту чтобы точно подхватилось” — можно передать delayMs.
 */
export async function sendpulseSetContactVariables({ contactId, variables, delayMs = 0 }) {
  const cid = String(contactId || "").trim();
  if (!cid) throw new Error("sendpulseSetContactVariables: missing contactId");

  const vars = variables || {};
  const entries = Object.entries(vars).map(([k, v]) => ({
    variable_name: String(k),
    variable_value: v == null ? "" : String(v),
  }));

  if (delayMs && Number(delayMs) > 0) await sleep(Number(delayMs));

  // 1) массивом
  try {
    return await spRequest("POST", "/telegram/contacts/setVariables", {
      contact_id: cid,
      variables: entries,
    });
  } catch (eBatchArray) {
    // 2) объектом
    try {
      const obj = {};
      for (const { variable_name, variable_value } of entries) obj[variable_name] = variable_value;

      return await spRequest("POST", "/telegram/contacts/setVariables", {
        contact_id: cid,
        variables: obj,
      });
    } catch (eBatchObject) {
      // 3) по одной
      const results = [];
      for (const { variable_name, variable_value } of entries) {
        try {
          const r = await spRequest("POST", "/telegram/contacts/setVariable", {
            contact_id: cid,
            variable_name,
            variable_value,
          });
          results.push({ name: variable_name, ok: true, r });
        } catch (eOne) {
          results.push({ name: variable_name, ok: false, error: String(eOne?.message || eOne) });
        }
      }

      const anyOk = results.some((x) => x.ok);
      if (!anyOk) {
        throw new Error(
          `SendPulse variables update failed. Tried: setVariables(array) + setVariables(object) + setVariable(one-by-one). Results: ${JSON.stringify(
            results,
            null,
            2
          )}`
        );
      }

      return { ok: true, partial: true, results };
    }
  }
}

/**
 * ✅ Запуск воронки (flow/chain) для конкретного contactId.
 * ВАЖНО:
 * - flowId — это ID воронки/цепочки (как в ссылке/настройке SendPulse), не “название”.
 * - Мы пробуем много вариантов, потому что в разных аккаунтах/версиях SendPulse пути отличаются.
 *
 * Если тебе нужно сначала записать переменные, а потом стартануть flow — лучше:
 *   await sendpulseSetContactVariables(...);
 *   await sendpulseStartFlow(...);
 */
export async function sendpulseStartFlow({ flowId, contactId, delayMs = 0 }) {
  const fid = String(flowId || "").trim();
  const cid = String(contactId || "").trim();
  if (!fid) throw new Error("sendpulseStartFlow: missing flowId");
  if (!cid) throw new Error("sendpulseStartFlow: missing contactId");

  if (delayMs && Number(delayMs) > 0) await sleep(Number(delayMs));

  // payloads: разные варианты ключей (SendPulse иногда ожидает chain_id вместо flow_id)
  const payloadVariants = [
    { flow_id: fid, contact_id: cid },
    { flowId: fid, contactId: cid },
    { chain_id: fid, contact_id: cid },
    { chainId: fid, contactId: cid },
  ];

  // endpoints: разные варианты путей
  const endpointVariants = [
    // flows
    "/telegram/flows/run",
    "/telegram/flows/start",
    "/telegram/flows/launch",
    // chains
    "/telegram/chains/run",
    "/telegram/chains/start",
    // contact helpers (встречается в некоторых продуктах)
    "/telegram/contacts/runFlow",
    "/telegram/contacts/startFlow",
    "/telegram/contacts/launchFlow",
    "/telegram/contacts/runChain",
    "/telegram/contacts/startChain",
  ];

  return tryVariants({ endpoints: endpointVariants, payloads: payloadVariants, timeoutMs: 20000 });
}
