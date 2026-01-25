// src/tribute/tribute-webhook.js
import { setAccess } from "../access/access-store.js";

/**
 * Ожидаем, что Tribute пришлёт что-то вроде:
 * {
 *   "event": "payment.succeeded",
 *   "plan": "basic" | "unlimited",
 *   "contactId": "68ee5d...",
 *   "paid_until": "2026-02-11T00:00:00Z" // если есть
 *   ...другие поля
 * }
 *
 * Если Tribute присылает эти данные в другом месте (metadata/custom_fields),
 * просто поправим чтение ниже.
 */
export async function tributeWebhook(req, res) {
  try {
    const body = req.body || {};
    // 1) проверить, что платёж успешен
    const okEvent =
      body.event === "payment.succeeded" ||
      body.status === "succeeded" ||
      body.paid === true;

    if (!okEvent) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // 2) достать contactId/plan
    const contactId =
      body.contactId ||
      body.metadata?.contactId ||
      body.custom_fields?.contactId ||
      null;

    const plan =
      body.plan ||
      body.metadata?.plan ||
      body.custom_fields?.plan ||
      null;

    if (!contactId || !plan) {
      console.error("TRIBUTE_WEBHOOK: missing contactId or plan", body);
      return res.status(400).json({ ok: false });
    }

    // 3) выставить доступ
    const paid_until =
      body.paid_until ||
      body.metadata?.paid_until ||
      null;

    setAccess(contactId, {
      plan, // "basic" | "unlimited"
      paid_until,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("TRIBUTE_WEBHOOK_ERROR:", e);
    res.status(500).json({ ok: false });
  }
}

/**
 * Удобный тест без Tribute:
 * GET /test/activate?contactId=...&plan=basic
 */
export async function handleTributeWebhook(req, res) {
  const contactId = req.query.contactId || null;
  const plan = req.query.plan || null;
  if (!contactId || !plan) return res.status(400).send("need contactId & plan");
  setAccess(contactId, { plan });
  res.send(`OK: ${contactId} → ${plan}`);
}
