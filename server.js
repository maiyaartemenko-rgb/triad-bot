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

// sMoF = unlimited, sMoE = basic (как ты сказала)
function planFromStartapp(startapp = "") {
  const s = String(startapp || "");
  if (s.includes("sMoF")) return "unlimited";
  if (s.includes("sMoE")) return "basic";
  return null;
}

// иногда Tribute присылает web_app_link: https://t.me/tribute/app?startapp=XXXX
function extractStartappValue(maybeUrlOrCode = "") {
  const s = String(maybeUrlOrCode || "").trim();
  if (!s) return "";
  if (s.includes("startapp=")) {
    const m = s.match(/startapp=([^&\s]+)/);
    return m ? m[1] : "";
  }
  return s; // уже код
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
// ВАЖНО: НЕ меняем startapp вообще.
// Просто редиректим на TRIBUTE_*_URL как есть.
// (cid нужен только чтобы ссылку строить в paywall, но Tribute его не использует)
app.get("/pay/basic", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_BASIC_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_BASIC_URL is not set");

  res.status(302).setHeader("Location", base);
  return res.end();
});

app.get("/pay/unlimited", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = String(process.env.TRIBUTE_UNLIMITED_URL || "").trim();
  if (!base) return res.status(500).send("TRIBUTE_UNLIMITED_URL is not set");

  res.status(302).setHeader("Location", base);
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

    // 1) startapp / web_app_link достаём откуда угодно
    const rawStartapp =
      q.startapp ||
      b.startapp ||
      b.startApp ||
      b?.payload?.startapp ||
      b?.payload?.web_app_link ||
      b?.web_app_link ||
      b?.payload?.webAppLink ||
      b?.telegram?.startapp ||
      b?.context?.startapp ||
      b?.details ||
      b?.order?.details ||
      b?.order?.comment ||
      "";

    const startapp = extractStartappValue(rawStartapp);

    // 2) plan
    const plan =
      normalizePlan(q.plan) ||
      normalizePlan(b.plan) ||
      normalizePlan(b?.payload?.plan) ||
      normalizePlan(b?.payload?.subscription_name) ||
      normalizePlan(b?.payload?.subscriptionName) ||
      normalizePlan(b?.subscription?.plan) ||
      normalizePlan(b?.product?.type) ||
      planFromStartapp(startapp);

    // 3) contactId: если вдруг Tribute когда-то начнёт присылать — подхватим
    let contactId = String(
      q.contactId ||
        q.contact_id ||
        q.cid ||
        b.contactId ||
        b.contact_id ||
        b.cid ||
        ""
    ).trim();

    // 4) иначе — главный путь: telegram_user_id -> tg-map-store
    if (!contactId) {
      const tgId =
        b?.payload?.telegram_user_id ||
        b?.telegram_user_id ||
        b?.payload?.user?.telegram_user_id ||
        b?.payload?.user_id ||
        b?.payload?.user?.id ||
        b?.user_id ||
        null;

      if (tgId) {
        contactId = String(getContactIdByTgId(String(tgId)) || "").trim();
      }
    }

    if (!contactId || !plan) {
      return res.status(400).json({
        ok: false,
        error: "need contactId & plan",
        got: {
          contactId: contactId || null,
          plan: plan || null,
          startapp: startapp || null,
        },
      });
    }

    // 5) paid_until: берём expires_at от Tribute, иначе +30 дней
    const paid_until =
      b?.payload?.expires_at ||
      b?.expires_at ||
      addDaysISO(30);

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
