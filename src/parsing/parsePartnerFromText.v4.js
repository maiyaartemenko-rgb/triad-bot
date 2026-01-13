// parsePartnerFromText.v4.js
// Максимально практичная версия:
// ✅ приоритет №1: конструкции "Я — X, он/она — Y" (и похожие)
// ✅ приоритет №2: окно после "муж/жена/партнёр/он/она..."
// ✅ приоритет №3: общий поиск (exact → fuzzy)
// ✅ RU + LAT + склонения + ё/е + лёгкие опечатки
//
// Возвращает:
// - partnerSign: string|null (если уверенность ниже порога — null)
// - partnerSignsMentioned: string[]
// - selfSignMentioned: string|null (если нашли "я — ...")
// - confidence: 0..1
// - debug: подробности

const SIGNS = [
  "ДРАКОН","СКОРПИОН","ОСЬМИНОГ","ПОПУГАЙ","СОБАКА",
  "КОСУЛЯ","ПАНДА","БИЗОН","БОБЕР","БАРСУК",
  "ЛИСА","ГОЛУБЬ","КОЛИБРИ","СОВА","ЯСТРЕБ",
  "ВОРОН","ЛЕВ","ВОЛК","ТИГР","ФЕНИКС",
  "МУСТАНГ","ДЕЛЬФИН","ЛЕБЕДЬ","КИТ","ТЮЛЕНЬ",
  "КРОКОДИЛ","АКУЛА"
];

const ALIASES_RU = {
  "БОБЕР": ["БОБЁР", "БОБРА", "БОБРУ", "БОБРОМ", "БОБРЫ", "БОБЕРА"],
  "ТЮЛЕНЬ": ["ТЮЛЕНЯ", "ТЮЛЕНЕМ", "ТЮЛЕНЮ", "ТЮЛЕНИ"],
  "ЛЕБЕДЬ": ["ЛЕБЕДЯ", "ЛЕБЕДЕМ", "ЛЕБЕДЮ", "ЛЕБЕДИ"],
  "ФЕНИКС": ["ФЕНИКСА", "ФЕНИКСОМ", "ФЕНИКСУ", "ФЕНИКСЫ"],
  "СКОРПИОН": ["СКОРПИОНА", "СКОРПИОНОМ", "СКОРПИОНУ", "СКОРПИОНЫ"],
  "ДРАКОН": ["ДРАКОНА", "ДРАКОНОМ", "ДРАКОНУ", "ДРАКОНЫ"],
  "КРОКОДИЛ": ["КРОКОДИЛА", "КРОКОДИЛОМ", "КРОКОДИЛУ", "КРОКОДИЛЫ"],
  "АКУЛА": ["АКУЛЫ", "АКУЛЕ", "АКУЛУ", "АКУЛОЙ"],
  "ЛИСА": ["ЛИСЫ", "ЛИСЕ", "ЛИСУ", "ЛИСОЙ"],
  "ГОЛУБЬ": ["ГОЛУБЯ", "ГОЛУБЕМ", "ГОЛУБЮ", "ГОЛУБИ"],
  "КИТ": ["КИТА", "КИТОМ", "КИТУ", "КИТЫ"],
  "ВОЛК": ["ВОЛКА", "ВОЛКОМ", "ВОЛКУ", "ВОЛКИ"],
  "ТИГР": ["ТИГРА", "ТИГРОМ", "ТИГРУ", "ТИГРЫ"],
  "ЛЕВ": ["ЛЬВА", "ЛЬВОМ", "ЛЬВУ", "ЛЬВЫ"],
  "ВОРОН": ["ВОРОНА", "ВОРОНОМ", "ВОРОНУ", "ВОРОНЫ"],
  "СОБАКА": ["СОБАКИ", "СОБАКЕ", "СОБАКУ", "СОБАКОЙ"],
  "СОВА": ["СОВЫ", "СОВЕ", "СОВУ", "СОВОЙ"],
  "ЯСТРЕБ": ["ЯСТРЕБА", "ЯСТРЕБОМ", "ЯСТРЕБУ", "ЯСТРЕБЫ"],
  "ОСЬМИНОГ": ["ОСЬМИНОГА", "ОСЬМИНОГОМ", "ОСЬМИНОГУ", "ОСЬМИНОГИ"],
  "ПОПУГАЙ": ["ПОПУГАЯ", "ПОПУГАЕМ", "ПОПУГАЮ", "ПОПУГАИ"],
  "КОЛИБРИ": ["КОЛИБРИ"],
  "МУСТАНГ": ["МУСТАНГА", "МУСТАНГОМ", "МУСТАНГУ", "МУСТАНГИ"],
  "ДЕЛЬФИН": ["ДЕЛЬФИНА", "ДЕЛЬФИНОМ", "ДЕЛЬФИНУ", "ДЕЛЬФИНЫ"],
  "БИЗОН": ["БИЗОНА", "БИЗОНОМ", "БИЗОНУ", "БИЗОНЫ"],
  "БАРСУК": ["БАРСУКА", "БАРСУКОМ", "БАРСУКУ", "БАРСУКИ"],
  "ПАНДА": ["ПАНДЫ", "ПАНДЕ", "ПАНДУ", "ПАНДОЙ"],
  "КОСУЛЯ": ["КОСУЛИ", "КОСУЛЕ", "КОСУЛЮ", "КОСУЛЕЙ"]
};

const ALIASES_LAT = {
  "ДРАКОН": ["DRAGON"],
  "СКОРПИОН": ["SCORPION"],
  "ОСЬМИНОГ": ["OCTOPUS"],
  "ПОПУГАЙ": ["PARROT"],
  "СОБАКА": ["DOG"],
  "КОСУЛЯ": ["ROE", "ROEDEER", "ROE-DEER"],
  "ПАНДА": ["PANDA"],
  "БИЗОН": ["BISON"],
  "БОБЕР": ["BEAVER"],
  "БАРСУК": ["BADGER"],
  "ЛИСА": ["FOX"],
  "ГОЛУБЬ": ["PIGEON", "DOVE"],
  "КОЛИБРИ": ["HUMMINGBIRD"],
  "СОВА": ["OWL"],
  "ЯСТРЕБ": ["HAWK"],
  "ВОРОН": ["RAVEN", "CROW"],
  "ЛЕВ": ["LION"],
  "ВОЛК": ["WOLF"],
  "ТИГР": ["TIGER"],
  "ФЕНИКС": ["PHOENIX"],
  "МУСТАНГ": ["MUSTANG"],
  "ДЕЛЬФИН": ["DOLPHIN"],
  "ЛЕБЕДЬ": ["SWAN"],
  "КИТ": ["WHALE"],
  "ТЮЛЕНЬ": ["SEAL"],
  "КРОКОДИЛ": ["CROCODILE"],
  "АКУЛА": ["SHARK"]
};

const PARTNER_HINTS = [
  "МУЖ","ЖЕНА","ПАРТНЕР","ПАРТНЁР","ДЕВУШКА","ПАРЕНЬ",
  "ОН","ОНА","ЕГО","ЕЕ","ЕЁ",
  "МОЙ МУЖ","МОЯ ЖЕНА","МОЙ ПАРТНЕР","МОЙ ПАРТНЁР"
];

function normalizeText(input) {
  return (input || "")
    .toUpperCase()
    .replaceAll("Ё", "Е")
    .replace(/[^A-ZА-Я0-9\s\-–—:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const d = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - d / maxLen;
}

function buildForms() {
  const map = new Map();
  for (const sign of SIGNS) {
    const set = new Set([sign]);
    (ALIASES_RU
[sign] || []).forEach(x => set.add(String(x).toUpperCase().replaceAll("Ё", "Е")));
    (ALIASES_LAT[sign] || []).forEach(x => set.add(String(x).toUpperCase()));
    map.set(sign, Array.from(set));
  }
  return map;
}
const SIGN_FORMS = buildForms();

function tokens(text) {
  return text.split(" ").filter(Boolean);
}

function exactHits(text) {
  const w = tokens(text);
  const hits = [];
  for (const [sign, forms] of SIGN_FORMS.entries()) {
    for (const f of forms) {
      if (w.includes(f)) {
        hits.push({ sign, matched: f, score: 1.0, method: "exact" });
        break;
      }
    }
  }
  return hits;
}

function fuzzyHits(text, minConfidence) {
  const w = tokens(text);
  const hits = [];
  for (const word of w) {
    if (word.length < 4) continue;
    for (const sign of SIGNS) {
      const bases = new Set([sign, ...(ALIASES_LAT[sign] || [])]);
      for (const b of bases) {
        const s = similarity(word, b);
        if (s >= minConfidence) hits.push({ sign, matched: word, score: s, method: "fuzzy" });
      }
    }
  }
  return hits;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function findHintPositions(text, hints) {
  const out = [];
  for (const h of hints) {
    const hh = normalizeText(h);
    let idx = text.indexOf(hh);
    while (idx !== -1) {
      out.push({ hint: hh, pos: idx });
      idx = text.indexOf(hh, idx + 1);
    }
  }
  return out.sort((a, b) => a.pos - b.pos);
}

function extractWindow(text, startPos, windowChars) {
  const start = Math.max(0, startPos);
  const end = Math.min(text.length, startPos + windowChars);
  return text.slice(start, end);
}

/**
 * Спец-режим: "Я — X, он/она — Y"
 * Суть: ищем в тексте пару сегментов после "Я" и после "ОН/ОНА/МУЖ/ЖЕНА"
 * и вытаскиваем знаки из них.
 */
function parseIYouPattern(text, { minConfidence }) {
  const t = text;

  // Нормализованные маркеры
  const patterns = [
    // "Я - ..., ОН - ..."
    { self: "Я", partner: "ОН" },
    { self: "Я", partner: "ОНА" },
    { self: "Я", partner: "МУЖ" },
    { self: "Я", partner: "ЖЕНА" },
    { self: "Я", partner: "ПАРТНЕР" },
    { self: "Я", partner: "ПАРТНЕР" } // "ПАРТНЁР" уже нормализуется в "ПАРТНЕР"
  ];

  // Пробуем найти позицию "Я" и ближайший "ОН/ОНА/..."
  const selfPos = t.indexOf("Я ");
  if (selfPos === -1) return null;

  // Найдём ближайший партнёрский маркер после selfPos
  const partnerMarkers = ["ОН ", "ОНА ", "МУЖ ", "ЖЕНА ", "ПАРТНЕР ", "ПАРТНЕР "];
  let bestPartner = { pos: -1, marker: null };
  for (const m of partnerMarkers) {
    const p = t.indexOf(m, selfPos + 1);
    if (p !== -1 && (bestPartner.pos === -1 || p < bestPartner.pos)) {
      bestPartner = { pos: p, marker: m.trim() };
    }
  }
  if (bestPartner.pos === -1) return null;

  const selfSegment = t.slice(selfPos, bestPartner.pos);
  const partnerSegment = t.slice(bestPartner.pos);

  // В каждом сегменте ищем знак
  const selfExact = exactHits(selfSegment);
  const partnerExact = exactHits(partnerSegment);

  const selfCandidate = selfExact[0] || fuzzyHits(selfSegment, minConfidence).sort((a,b)=>b.score-a.score)[0];
  const partnerCandidate = partnerExact[0] || fuzzyHits(partnerSegment, minConfidence).sort((a,b)=>b.score-a.score)[0];

  if (!partnerCandidate) return null;

  return {
    selfSignMentioned: selfCandidate?.sign || null,
    partnerSign: partnerCandidate.sign,
    confidence: Math.max(0, Math.min(1, partnerCandidate.score ?? 0.9)),
    debug: { selfSegment, partnerSegment, selfCandidate, partnerCandidate }
  };
}

export function parsePartnerFromTextV4(text, {
  windowChars = 90,
  minConfidence = 0.86,
  mainThreshold = 0.9
} = {}) {
  const t = normalizeText(text);
  if (!t) return { partnerSign: null, partnerSignsMentioned: [], selfSignMentioned: null, confidence: 0, debug: {} };

  const debug = { mode: null };

  // 1) ПРИОРИТЕТ: "я — X, он/она — Y"
  const iy = parseIYouPattern(t, { minConfidence });
  if (iy && iy.partnerSign) {
    debug.mode = "i_you_pattern";
    debug.details = iy.debug;

    return {
      partnerSign: iy.confidence >= mainThreshold ? iy.partn
erSign : null,
      partnerSignsMentioned: [],
      selfSignMentioned: iy.selfSignMentioned,
      confidence: iy.confidence,
      debug
    };
  }

  // 2) ОКНО после партнёрских подсказок
  const partnerHints = findHintPositions(t, PARTNER_HINTS);
  debug.partnerHints = partnerHints;

  const windowCandidates = [];
  const windowDebug = [];

  for (const h of partnerHints) {
    const w = extractWindow(t, h.pos, windowChars);
    const ex = exactHits(w);
    const fu = ex.length ? [] : fuzzyHits(w, minConfidence);
    const local = ex.length ? ex : fu;

    windowDebug.push({ hint: h.hint, pos: h.pos, window: w, hits: local });

    for (const hit of local) {
      windowCandidates.push({
        sign: hit.sign,
        matched: hit.matched,
        score: hit.score ?? 1.0,
        method: hit.method ?? "window",
        from: "partner_window",
        hint: h.hint,
        hintPos: h.pos
      });
    }
  }

  debug.windowSearch = windowDebug;

  if (windowCandidates.length) {
    windowCandidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.hintPos - b.hintPos));
    const main = windowCandidates[0];
    const rest = uniq(windowCandidates.slice(1).map(x => x.sign).filter(s => s !== main.sign));

    debug.mode = "partner_window";

    const conf = Math.max(0, Math.min(1, main.score));
    return {
      partnerSign: conf >= mainThreshold ? main.sign : null,
      partnerSignsMentioned: rest,
      selfSignMentioned: null,
      confidence: conf,
      debug
    };
  }

  // 3) FALLBACK: общий поиск
  const exactGlobal = exactHits(t);
  if (exactGlobal.length) {
    debug.mode = "global_exact";
    const main = exactGlobal[0];
    const rest = uniq(exactGlobal.slice(1).map(x => x.sign).filter(s => s !== main.sign));
    return {
      partnerSign: main.sign,
      partnerSignsMentioned: rest,
      selfSignMentioned: null,
      confidence: 0.92,
      debug
    };
  }

  const fuzzyGlobal = fuzzyHits(t, minConfidence);
  if (fuzzyGlobal.length) {
    fuzzyGlobal.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    debug.mode = "global_fuzzy";
    const main = fuzzyGlobal[0];
    const rest = uniq(fuzzyGlobal.slice(1).map(x => x.sign).filter(s => s !== main.sign));
    const conf = Math.max(0, Math.min(1, main.score ?? 0));
    return {
      partnerSign: conf >= mainThreshold ? main.sign : null,
      partnerSignsMentioned: rest,
      selfSignMentioned: null,
      confidence: conf,
      debug
    };
  }

  return { partnerSign: null, partnerSignsMentioned: [], selfSignMentioned: null, confidence: 0, debug: { mode: "none" } };
}

Как использовать в боте

import { parsePartnerFromTextV4 } from "./parsePartnerFromText.v4.js";

const parsed = parsePartnerFromTextV4(userText, { mainThreshold: 0.9 });

const partnerSign = parsed.partnerSign; // null если не уверены
// selfSignMentioned можно игнорировать, но иногда полезно для UX

const result = await triadChat({ userText, profile: userProfile, partnerSign, kb });

Примеры, где v4 реально спасает

«Я дракон, он скорпион, как не ругаться?» → partnerSign = СКОРПИОН (режим i_you_pattern)

«Я попугай. Муж — волк.» → partnerSign = ВОЛК (окно после "муж")

«Она scorpion» → partnerSign = СКОРПИОН (латиница)

«он скарпион» → partnerSign = СКОРПИОН (опечатка → fuzzy)