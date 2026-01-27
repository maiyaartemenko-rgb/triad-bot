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

function parseCidFromStartapp(startapp = "") {
  // ожидаем ...__cid__CONTACT_ID
  const s = String(startapp || "");
  const m = s.match(/__cid__([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function planFromStartapp(startapp = "") {
  // ВАЖНО: подставь свои коды startapp от Tribute:
  // basic -> sMoF
  // unlimited -> sMoE
  const s = String(startapp || "");
  if (s.includes("sMoF")) return "basic";
  if (s.includes("sMoE")) return "unlimited";
  return null;
}

function normalizePlan(p) {
  const x = String(p || "").toLowerCase().trim();
  if (!x) return null;
  if (x.includes("unlimit")) return "unlimited";
  if (x.includes("basic")) return "basic";
  return null;
}

// --- PAY REDIRECTS (Tribute) ---
// env:
// TRIBUTE_BASIC_URL
// TRIBUTE_UNLIMITED_URL
function withContactIdInStartapp(url, contactId) {
  // startapp=CODE__cid__CONTACT_ID
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

// ---------- DEBUG ACCESS ----------
app.get("/debug/access", (req, res) => {
  try {
    if (!fs.existsSync("/data/access.json")) {
      return res.json({
        ok: true,
        users: {},
        note: "access.json ещё не создан — появится после первого вопроса",
      });
    }
    const txt = fs.readFileSync("/data/access.json", "utf8");
    res.type("json").send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- SENDPULSE WEBHOOK ----------
app.post("/sendpulse/webhook", handleSendpulseWebhook);

// ---------- TRIBUTE WEBHOOK (ЕДИНСТВЕННЫЙ РОУТ!) ----------
async function tributeWebhook(req, res) {
  try {
    const q = req.query || {};
    const b = req.body || {};

    // Логи — чтобы видеть, что реально прислал Tribute
    console.log("TRIBUTE_WEBHOOK_METHOD:", req.method);
    console.log("TRIBUTE_WEBHOOK_QUERY:", q);
    console.log("TRIBUTE_WEBHOOK_BODY:", JSON.stringify(b, null, 2));

    // 1) startapp достаём откуда угодно
    const startapp =
      q.startapp ||
      b.startapp ||
      b.startApp ||
      b?.telegram?.startapp ||
      b?.telegram?.startApp ||
      b?.context?.startapp ||
      b?.context?.startApp ||
      b?.order?.details ||
      b?.order?.comment ||
      b?.details ||
      b?.data?.startapp ||
      b?.payload?.startapp ||
      "";

    // 2) contactId/cid: query/body/из startapp
    const contactId = String(
      q.contactId ||
        q.contact_id ||
        q.cid ||
        b.contactId ||
        b.contact_id ||
        b.cid ||
        parseCidFromStartapp(startapp) ||
        ""
    ).trim();

    // 3) plan: явный или из startapp-кода
    const plan =
      normalizePlan(q.plan) ||
      normalizePlan(b.plan) ||
      normalizePlan(b?.subscription?.plan) ||
      normalizePlan(b?.product?.type) ||
      planFromStartapp(startapp);

    if (!contactId || !plan) {
      return res.status(400).json({
        ok: false,
        error: "need contactId & plan",
        got: { contactId: contactId || null, plan: plan || null, startapp },
      });
    }

    // 4) подписка на 30 дней для basic и unlimited
   const paid_until =
  body?.payload?.expires_at ||
  body?.expires_at ||
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

// принимаем и POST, и GET (на случай тестов)
app.post("/tribute/webhook", tributeWebhook);
app.get("/tribute/webhook", tributeWebhook);

// если contactId не нашли через startapp/детали
if (!contactId) {
  const tgId =
    body?.payload?.telegram_user_id ||
    body?.telegram_user_id ||
    body?.payload?.user?.telegram_user_id ||
    null;

  if (tgId) {
    contactId = getContactIdByTgId(tgId) || "";
  }
}

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

// ---------- START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
