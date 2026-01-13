import { query } from "./db.js";

export async function getProfile(telegramId) {
  const id = String(telegramId);
  const res = await query(`select * from profiles where telegram_id = $1`, [id]);
  const row = res.rows[0];
  if (!row) return null;

  return {
    main_sign: row.main_sign,
    active_signs: row.active_signs_json || []
  };
}

export async function upsertProfile(telegramId, profile) {
  const id = String(telegramId);

  const main = profile?.main_sign ?? null;
  const actives = Array.isArray(profile?.active_signs) ? profile.active_signs : [];

  const res = await query(
    `insert into profiles (telegram_id, main_sign, active_signs_json, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (telegram_id)
     do update set
       main_sign = excluded.main_sign,
       active_signs_json = excluded.active_signs_json,
       updated_at = now()
     returning *`,
    [id, main, JSON.stringify(actives)]
  );

  const row = res.rows[0];
  return {
    main_sign: row.main_sign,
    active_signs: row.active_signs_json || []
  };
}