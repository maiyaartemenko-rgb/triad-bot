// server.js
import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";

import { triadChat } from "./src/triad/triad-openai.js";
import { handleSendpulseWebhook } from "./src/sendpulse/sendpulse-webhook.js";
import { setAccess } from "./src/access/access-store.js";
import { getContactIdByTgId } from "./src/access/tg-map-store.js";

dotenv.config();

const app = express();

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- HELPERS ----------
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function normalizePlan(p) {
  const x = String(p || "").toLowerCase().trim();
  if (!x) return null;
  if (x.includes("unlimit")) return "unlimited";
  if (x.includes("basic")) return "basic";
  return null;
}

// base64url (только [A-Za-z0-9_-])
function b64urlEncode(str) {
  return Buffer.from(String(str), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function b64urlDecode(str) {
  try {
    let s = String(str || "").replaceAll("-", "+").replaceAll("_", "/");
    // pad
    while (s.length % 4 !== 0) s += "=";
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Пытаемся вытащить contactId из startapp:
 * 1) sMoF__cid__ENC
 * 2) sMoFcidENC
 * где ENC = b64url(contactId) или иногда прямо contactId
 */
function parseCidFromStartapp(startapp = "") {
  const s = String(startapp || "");

  // вариант 1: __cid__XXXX
  let m = s.match(/__cid__([A-Za-z0-9_-]{6,})/);
  if (m) {
    const raw = m[1];
    return b64urlDecode(raw) || raw;
  }

  // вариант 2: cidXXXX
  m = s.match(/cid([A-Za-z0-9_-]{6,})/);
  if (m) {
    const raw = m[1];
    return b64urlDecode(raw) || raw;
  }

  return null;
}

// Определяем план по startapp-коду
function planFromStartapp(startapp = "") {
  const s = String(startapp || "");
  if (s.includes("sMoF")) return "basic";
  if (s.includes("sMoE")) return "unlimited";
  return null;
}

/**
 * Делаем безопасный startapp: только буквы/цифры/подчёркивание/дефис.
 * Вшиваем contactId в виде base64url, чтобы ничего не сломалось:
 * startapp=sMoFcidENCODED
 */
function withContactIdInStartapp(url, contactId) {
  const cid = String(contactId || "").trim();
  if (!cid) return String(url);

  const encodedCid = b64urlEncode(cid);

  return String(url).replace(/startapp=([^&]+)/, (_, code) => {
    const safeCode = String(code).replace(/[^a-zA-Z0-9_]/g, "");
    return `startapp=${safeCode}cid${encodedCid}`;
  });
}

function requireCid(req, res) {
  const cid = String(req.query.cid || "").trim();
  if (!cid) {
    res.status(400).send("Missing cid");
    return null;
  }
  return cid;
}

// ---------- PAY REDIRECTS (Tribute) ----------
app.get("/pay/basic", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_BASIC_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_BASIC_URL is not set");

  const link = withContactIdInStartapp(base, cid);

  // более “железный” редирект
  res.status(302);
  res.setHeader("Location", link);
  return res.end();
});

app.get("/pay/unlimited", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_UNLIMITED_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_UNLIMITED_URL is not set");

  const link = withContactIdInStartapp(base, cid);

  res.status(302);
  res.setHeader("Location", link);
  return res.end();
});

// ---------- DEBUG ACCESS ----------
app.get("/debug/access", (req, res) => {
  try {
    const file = "/data/access.json";
    if (!fs.existsSync(file)) {
      return res.json({
        ok: true,
        users: {},
        note: "access.json ещё не создан — появится после первого вопроса",
      });
    }
    const txt = fs.readFileSync(file, "utf8");
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- SENDPULSE WEBHOOK ----------
app.post("/sendpulse/webhook", handleSendpulseWebhook);

// ---------- TRIBUTE WEBHOOK ----------
async function tributeWebhook(req, res) {
  try {
    const q = req.query || {};
    const b = req.body || {};

    console.log("TRIBUTE_WEBHOOK_METHOD:", req.method);
    console.log("TRIBUTE_WEBHOOK_QUERY:", q);
    console.log("TRIBUTE_WEBHOOK_BODY:", JSON.stringify(b, null, 2));

    const startapp =
      q.startapp ||
      b.startapp ||
      b.startApp ||
      b?.payload?.startapp ||
      b?.payload?.web_app_link ||
      b?.telegram?.startapp ||
      b?.context?.startapp ||
      b?.order?.details ||
      b?.order?.comment ||
      b?.details ||
      "";

    const plan =
      normalizePlan(q.plan) ||
      normalizePlan(b.plan) ||
      normalizePlan(b?.payload?.plan) ||
      normalizePlan(b?.payload?.subscription_name) ||
      normalizePlan(b?.subscription?.plan) ||
      normalizePlan(b?.product?.type) ||
      planFromStartapp(startapp);

    let contactId = String(
      q.contactId ||
        q.contact_id ||
        q.cid ||
        b.contactId ||
        b.contact_id ||
        b.cid ||
        parseCidFromStartapp(startapp) ||
        ""
    ).trim();

    if (!contactId) {
      const tgId =
        b?.payload?.telegram_user_id ||
        b?.telegram_user_id ||
        b?.payload?.user?.telegram_user_id ||
        b?.payload?.user?.id ||
        null;

      if (tgId) {
        contactId = String(getContactIdByTgId(String(tgId)) || "").trim();
      }
    }

    if (!contactId || !plan) {
      return res.status(400).json({
        ok: false,
        error: "need contactId & plan",
        got: { contactId: contactId || null, plan: plan || null, startapp },
      });
    }

    const paid_until = b?.payload?.expires_at || b?.expires_at || addDaysISO(30);

    setAccess(contactId, {
      plan,
      paid_until,
      daily_used: 0,
      last_reset_date: new Date().toISOString().slice(0, 10),
    });

    return res.json({ ok: true, contactId, plan, paid_until });
  } catch (e) {
    console.error("TRIBUTE_WEBHOOK_ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.post("/tribute/webhook", tributeWebhook);
app.get("/tribute/webhook", tributeWebhook);

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- OPTIONAL: CHAT API ----------
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || "");
    const profile = body.profile || {};
    const partnerSign = body.partnerSign || null;

    if (!text.trim()) return res.status(400).json({ error: "Missing text" });

    const result = await triadChat({
      userText: text,
      profile,
      partnerSign,
    });

    res.json({
      ok: true,
      answer: result.answer,
      mode: result.mode,
      missing_signs: result.missing_signs || [],
    });
  } catch (err) {
    console.error("CHAT_ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
