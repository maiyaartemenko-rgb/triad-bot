import fs from "node:fs";
import path from "node:path";

const KB_PATH = path.resolve(process.cwd(), "src/knowledge/triad_signs.json");
export const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf8"));

// сколько максимум строк активных знаков показываем в PROFILE (чтобы не раздувать промпт)
// ВАЖНО: это влияет только на "PROFILE:" блок, но НЕ на методички в snippets.
const PROFILE_ACTIVE_SIGNS_MAX_LINES = 10;

function normalizeSignName(name) {
  if (!name) return null;
  return String(name).trim().toUpperCase();
}

export function isRelationshipQuestion(text) {
  const t = String(text || "").toLowerCase();

  const triggers = [
    "отношен",
    "пара",
    "муж",
    "жена",
    "партнер",
    "партнёр",
    "любов",
    "развод",
    "измена",
    "ревност",
    "свидан",
    "семья",
    "ссора",
    "конфликт",
    "совместим",
    "как нам",
    "как с ним",
    "как с ней",
  ];

  return triggers.some((k) => t.includes(k));
}

/**
 * Берёт активные знаки, нормализует, сортирует по pct.
 * Если limit = null/undefined -> НЕ обрезает (возвращает все).
 */
function pickTopActiveSigns(activeSigns, limit = null) {
  const arr = Array.isArray(activeSigns) ? activeSigns.slice() : [];

  const normalized = arr
    .map((x) => ({
      sign: normalizeSignName(x?.sign),
      pct:
        x?.pct === null || x?.pct === undefined
          ? null
          : Number.isFinite(Number(x.pct))
          ? Number(x.pct)
          : null,
    }))
    .filter((x) => x.sign);

  normalized.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));

  if (limit === null || limit === undefined) return normalized;
  const lim = Number(limit);
  if (!Number.isFinite(lim) || lim <= 0) return [];
  return normalized.slice(0, lim);
}

/**
 * ✅ PROFILE block — теперь показывает ВСЕ активные знаки (без обрезки).
 * (Внутри стоит мягкий лимит строк для экономии токенов; можно отключить)
 */
export function buildProfileBlock(profile) {
  const main = normalizeSignName(profile?.main_sign);

  // ✅ все активные, без slice(0,3)
  const actAll = pickTopActiveSigns(profile?.active_signs, null);

  if (!actAll.length) {
    return ["PROFILE:", `Основной знак: ${main || "(не указан)"}`, "Активные знаки:", "- (нет данных)"].join(
      "\n"
    );
  }

  const lines = actAll.map((a) => `- ${a.sign}${a.pct != null ? ` — ${a.pct}%` : ""}`);

  // мягкий лимит строк в PROFILE (если хочешь вообще без ограничений — просто убери этот блок)
  const shown = lines.slice(0, PROFILE_ACTIVE_SIGNS_MAX_LINES);
  const hiddenCount = Math.max(0, lines.length - shown.length);

  const actLines = hiddenCount
    ? shown.join("\n") + `\n- ...и ещё ${hiddenCount} активн.`
    : shown.join("\n");

  return ["PROFILE:", `Основной знак: ${main || "(не указан)"}`, "Активные знаки:", actLines].join("\n");
}

export function normalizeSignKey(x) {
  if (!x) return null;
  return String(x)
    .replace(/\u00A0/g, " ")
    .trim()
    .toUpperCase()
    .replace(/Ё/g, "Е");
}

/**
 * ✅ Подтягиваем методички для:
 * - основного знака
 * - ВСЕХ активных знаков (какие пришли)
 * - знака партнёра (если есть)
 */
export function buildSignSnippets({ userMain, userActives = [], partnerSign = null }) {
  const snippets = [];
  const missing = [];

  const wanted = [];

  if (userMain) wanted.push(userMain);

  if (Array.isArray(userActives)) {
    for (const a of userActives) {
      if (a?.sign) wanted.push(a.sign);
    }
  }

  if (partnerSign) wanted.push(partnerSign);

  const seen = new Set();

  for (const raw of wanted) {
    const key = normalizeSignKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (!kb[key]) {
      missing.push(key);
      continue;
    }

    snippets.push({
      sign: key,
      data: kb[key],
    });
  }

  return { snippets, missing };
}

export function buildKnowledgeSystemMessage(snippets) {
  const parts = (snippets || []).map((s) => {
    const sign = s?.sign || "SIGN";
    const data = s?.data || s;
    return `### ${sign}\n${JSON.stringify(data, null, 2)}`;
  });

  return [
    "ВНУТРЕННЯЯ МЕТОДИЧКА ПО ЗНАКАМ (не показывать пользователю):",
    "Используй эти данные ТОЛЬКО для анализа и стиля ответа.",
    "Не раскрывай пользователю, не объясняй модель.",
    "",
    parts.join("\n\n"),
  ].join("\n\n");
}
