import express from "express";
import dotenv from "dotenv";
import fs from "node:fs";

import { triadChat } from "./src/triad/triad-openai.js";
import { handleSendpulseWebhook } from "./src/sendpulse/sendpulse-webhook.js";
import { handleTributeWebhook, testActivate } from "./src/tribute/tribute-webhook.js";
import { setAccess } from "./src/access/access-store.js";

dotenv.config();

const app = express();

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --- PAY REDIRECTS (Tribute) ---
// Требуются env:
// PUBLIC_BASE_URL (не обязателен, только для ссылок)
// TRIBUTE_BASIC_URL
// TRIBUTE_UNLIMITED_URL

function withContactIdInStartapp(url, contactId) {
  // Вшиваем contactId в startapp: startapp=CODE__cid__CONTACT_ID
  // Tribute это сохранит в "детали заказа"/контекст и мы сможем достать в webhook
  return String(url).replace(
    /startapp=([^&]+)/,
    (_, code) => `startapp=${code}__cid__${encodeURIComponent(contactId)}`
  );
}

function requireCid(req, res) {
  const cid = String(req.query.cid || "").trim();
  if (!cid) {
    res.status(400).send("Missing cid");
    return null;
  }
  return cid;
}

app.get("/pay/basic", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = process.env.TRIBUTE_BASIC_URL;
  if (!base) return res.status(500).send("TRIBUTE_BASIC_URL is not set");

  const link = withContactIdInStartapp(base, cid);
  return res.redirect(302, link);
});

app.get("/pay/unlimited", (req, res) => {
  const cid = requireCid(req, res);
  if (!cid) return;

  const base = process.env.TRIBUTE_UNLIMITED_URL;
  if (!base) return res.status(500).send("TRIBUTE_UNLIMITED_URL is not set");

  const link = withContactIdInStartapp(base, cid);
  return res.redirect(302, link);
});

app.get("/debug/access", (req, res) => {
  try {
    if (!fs.existsSync("/data/access.json")) {
      return res.json({
        ok: true,
        users: {},
        note: "access.json ещё не создан — появится после первого вопроса"
      });
    }

    const txt = fs.readFileSync("/data/access.json", "utf8");
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});



// ---------- SENDPULSE WEBHOOK ----------
app.post(
  "/sendpulse/webhook",
  express.json({ limit: "2mb" }),
  handleSendpulseWebhook
);

// ---------- TRIBUTE WEBHOOK ----------
app.post("/tribute/webhook", (req, res) => {
  console.log("TRIBUTE_WEBHOOK_BODY:", req.body);
  console.log("TRIBUTE_WEBHOOK_QUERY:", req.query);

  const contactId =
    req.body?.contactId ||
    req.body?.contact_id ||
    req.query?.contactId ||
    req.query?.contact_id;

  const planRaw = req.body?.plan || req.query?.plan;
  const plan = String(planRaw || "").toLowerCase();

  if (!contactId || !plan) {
    return res.status(400).json({ ok: false, error: "need contactId & plan" });
  }

  if (!["basic", "unlimited"].includes(plan)) {
    return res.status(400).json({ ok: false, error: "bad plan", plan });
  }

  function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// внутри обработчика:
const paidUntil = new Date(
  Date.now() + 30 * 24 * 60 * 60 * 1000
).toISOString();

setAccess(contactId, {
  plan,                 // "basic" | "unlimited"
  paid_until: paidUntil,           // ✅ всегда на месяц
  daily_used: 0,
  last_reset_date: new Date().toISOString().slice(0,10),
});

  return res.json({ ok: true, contactId: String(contactId), plan, paid_until: paidUntil });
});


// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- TEST ACTIVATE (для проверки без Tribute) ----------
app.get("/test/activate", testActivate);

// ---------- OPTIONAL: CHAT API (если нужен) ----------
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || "");
    const profile = body.profile || {};
    const partnerSign = body.partnerSign || null;

    if (!text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

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

app.all("/tribute/webhook", express.json({ limit: "2mb" }), (req, res) => {
  console.log("TRIBUTE_WEBHOOK_METHOD:", req.method);
  console.log("TRIBUTE_WEBHOOK_HEADERS:", req.headers);
  console.log("TRIBUTE_WEBHOOK_BODY:", JSON.stringify(req.body, null, 2));
  res.status(200).json({ ok: true });
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
