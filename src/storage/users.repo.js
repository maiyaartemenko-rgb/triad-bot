import { query } from "./db.js";

export async function getOrCreateUser(telegramId) {
  const id = String(telegramId);

  // Создаём пользователя, если нет
  await query(
    `insert into users (telegram_id)
     values ($1)
     on conflict (telegram_id) do nothing`,
    [id]
  );

  const res = await query(`select * from users where telegram_id = $1`, [id]);
  return res.rows[0] || null;
}

export async function setPlan(telegramId, plan, paidUntil = null) {
  const id = String(telegramId);
  const res = await query(
    `update users
     set plan = $2,
         paid_until = $3
     where telegram_id = $1
     returning *`,
    [id, plan, paidUntil]
  );
  return res.rows[0] || null;
}

export async function startTrialIfNeeded(telegramId) {
  const id = String(telegramId);

  const res = await query(
    `update users
     set trial_started_at = coalesce(trial_started_at, now())
     where telegram_id = $1
     returning *`,
    [id]
  );
  return res.rows[0] || null;
}