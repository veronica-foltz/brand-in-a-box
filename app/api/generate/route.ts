import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ------------ request & data types ------------ */
type GenReq = {
  product: string;
  category?: string;
  keyBenefit?: string;
  audience?: string;
  tone?: string;
  platform?: string;
  imageStyle?: string;
  colorHint?: string;
  includeImage?: boolean;
  imageQuery?: string;
};

type StrictCopy = {
  tagline: string;
  caption: string;
  shortDescription: string;
  hashtags: string[];
};

type PexelsPhoto = { src?: { large2x?: string; large?: string; medium?: string } };
type PexelsSearch = { photos?: PexelsPhoto[] };

/* ------------ env ------------ */
const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const isVercel = process.env.VERCEL === "1";

/* ========== string helpers ========== */
const clampWords = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");
const slugParts = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const firstWordTag = (s: string) =>
  s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "brand";

const categoryTag = (cat?: string) => {
  const c = (cat || "").toLowerCase();
  if (/(beverage|drink|coffee|tea|brew)/.test(c)) return "#beverage";
  if (/(skincare|skin|beauty|serum|cream)/.test(c)) return "#skincare";
  if (/(apparel|fashion|clothing|wear)/.test(c)) return "#apparel";
  if (/(gadget|tech|device|electronics)/.test(c)) return "#gadget";
  if (/pet/.test(c)) return "#pet";
  if (/home/.test(c)) return "#home";
  if (/food|snack|granola|protein/.test(c)) return "#food";
  return "#brand";
};

/* ========== deterministic variety ========== */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pick<T>(arr: T[], seed: number, salt: number) {
  return arr[(seed + salt) % arr.length];
}

/* ========== local composer (no LLM) ========== */
function composeCopy(
  product: string,
  category?: string,
  keyBenefit?: string,
  audience?: string,
  tone?: string,
  platform?: string
): { copy: StrictCopy; debug: Record<string, unknown> } {
  const seed = hashString([product, category, keyBenefit, audience, tone, platform].join("|"));

  const toneWords: Record<string, string[]> = {
    friendly: ["friendly", "easy", "everyday", "feel-good", "simple", "welcoming"],
    playful:  ["playful", "cheeky", "fun", "vibrant", "lively", "bright"],
    luxury:   ["luxury", "elegant", "refined", "premium", "polished", "sleek"],
    bold:     ["bold", "striking", "confident", "punchy", "dynamic", "powerful"],
    calm:     ["calm", "soft", "clean", "minimal", "subtle", "gentle"],
  };
  const verbs    = ["Discover", "Try", "Meet", "Enjoy", "Upgrade to", "Experience", "Unwrap", "Level up with", "Bring home"];
  const closers  = ["made for you", "built for daily life", "crafted with care", "designed to delight", "with zero fuss", "ready when you are", "in seconds"];
  const useCases = ["everyday use", "busy mornings", "weekend plans", "work & play", "on-the-go moments", "your routine", "content days"];

  const catBits: Record<string, string[]> = {
    beverage: ["refreshment", "flavor", "sips", "energy", "cool down", "brew", "pick-me-up"],
    skincare: ["glow", "hydration", "smoothness", "care", "routine", "radiance", "skin-first"],
    apparel:  ["comfort", "style", "fit", "layers", "everyday wear", "outfits", "staples"],
    gadget:   ["smarts", "power", "control", "speed", "simplicity", "connectivity", "efficiency"],
    pet:      ["tail wags", "purrs", "treat time", "cleanups", "happy bowls", "walks", "bonding"],
    home:     ["coziness", "ease", "tidy spaces", "warmth", "every corner", "home life", "refresh"],
    food:     ["flavor", "crunch", "protein", "snack time", "goodness", "bites", "fuel"],
    other:    ["quality", "value", "joy", "fresh starts", "daily wins", "ease", "go-tos"],
  };

  const normCat = (() => {
    const c = (category || "").toLowerCase();
    if (/(beverage|drink|coffee|tea|brew)/.test(c)) return "beverage";
    if (/(skincare|skin|beauty|serum|cream)/.test(c)) return "skincare";
    if (/(apparel|fashion|clothing|wear)/.test(c))   return "apparel";
    if (/(gadget|tech|device|electronics)/.test(c))  return "gadget";
    if (/pet/.test(c))                                return "pet";
    if (/home/.test(c))                               return "home";
    if (/food|snack|granola|protein/.test(c))        return "food";
    return "other";
  })();

  const toneKey = (tone || "friendly").toLowerCase();
  const tones = toneWords[toneKey] || toneWords["friendly"];

  const pShort = clampWords(product, 5);
  const pSlug  = slugParts(product);
  const pEmph  = pSlug.slice(0, 3).map(w => w[0]?.toUpperCase() + w.slice(1)).join(" ");

  const t1 = pick(tones, seed, 1);
  const t2 = pick(tones, seed, 2);
  const v  = pick(verbs, seed, 3);
  const c1 = pick(closers, seed, 4);
  const uc = pick(useCases, seed, 5);
  const catPhrase = pick(catBits[normCat], seed, 6);
  const benefit = (keyBenefit && keyBenefit.trim()) || pick(catBits[normCat], seed, 7);

  // 9 templates → much more variety; seeded pick
  const templates = [
    { tl: clampWords(`${pShort}: ${t1} ${benefit}`, 8),
      cp: clampWords(`${v} ${pShort} — ${t2} ${benefit}, ${c1}.`, 26),
      sd: `${pShort} brings ${benefit} with a ${t1}, ${t2} feel. Perfect for ${audience || "everyone"} on ${platform || "social"}.` },
    { tl: clampWords(`${pEmph} • ${benefit} ${normCat !== "other" ? "for " + normCat : ""}`, 8),
      cp: clampWords(`${v} ${pShort} and feel the ${catPhrase}. Built for ${uc}.`, 26),
      sd: `Made to deliver ${benefit} without the guesswork. ${pShort} fits into ${audience || "your"} routine.` },
    { tl: clampWords(`${pShort}: ${catPhrase}, ${benefit}`, 8),
      cp: clampWords(`${v} the ${t1} choice — ${pShort} keeps ${uc} simple.`, 26),
      sd: `${pShort} focuses on ${benefit}. A ${t2} touch that works across ${platform || "every platform"}.` },
    { tl: clampWords(`${pShort} that brings ${benefit}`, 8),
      cp: clampWords(`Because ${audience || "you"} deserve ${catPhrase}.`, 20),
      sd: `${pShort} is about ${benefit} with ${t1} vibes — ideal for ${uc}.` },
    { tl: clampWords(`${pEmph}: ${t1} by design`, 8),
      cp: clampWords(`${v} ${pShort}. ${t2} feel, ${benefit} results.`, 22),
      sd: `${pShort} turns ${uc} into a ${t1} moment. Built for ${audience || "everyday"} use.` },
    { tl: clampWords(`${pShort} • ${catPhrase} made easy`, 8),
      cp: clampWords(`${v} ${pShort} — ${benefit} without the hassle.`, 22),
      sd: `From first try to daily habit, ${pShort} keeps ${platform || "your feed"} ${t2}.` },
    { tl: clampWords(`${pShort}: the ${t1} pick for ${normCat}`, 8),
      cp: clampWords(`${v} ${pShort}. ${benefit}, ${c1}.`, 20),
      sd: `${pShort} elevates ${normCat} with ${benefit}. Great for ${audience || "anyone"}.` },
    { tl: clampWords(`${pEmph} reimagined`, 8),
      cp: clampWords(`${v} ${pShort} and feel ${benefit} instantly.`, 18),
      sd: `${pShort} keeps ${uc} on track with a ${t2} touch.` },
    { tl: clampWords(`${pShort}: ${benefit} for ${audience || "your day"}`, 8),
      cp: clampWords(`${v} ${pShort} — ${catPhrase} meets ${t1} design.`, 22),
      sd: `${pShort} brings ${benefit} to ${platform || "social"} without the noise.` },
  ];
  const templateIndex = seed % templates.length;
  const T = templates[templateIndex];

  const tags = new Set<string>([
    `#${firstWordTag(product)}`,
    categoryTag(category).toLowerCase(),
    `#${(benefit || catPhrase).toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
    "#new",
    "#daily",
  ]);

  const copy: StrictCopy = {
    tagline: T.tl,
    caption: T.cp,
    shortDescription: T.sd,
    hashtags: Array.from(tags).slice(0, 5),
  };

  // Make absolutely sure the product is mentioned in tagline & caption
  const pLower = product.toLowerCase();
  if (!copy.tagline.toLowerCase().includes(pLower)) {
    copy.tagline = `${clampWords(product, 3)}: ${copy.tagline}`;
  }
  if (!copy.caption.toLowerCase().includes(pLower)) {
    copy.caption = `${copy.caption} (${clampWords(product, 3)})`;
  }

  return {
    copy,
    debug: {
      seed,
      templateIndex,
      normCat,
      chosenTone1: t1,
      chosenTone2: t2,
      catPhrase,
      benefitResolved: benefit,
    },
  };
}

/* ========== images (Pexels multi-candidates) ========== */
function buildImageQueries(
  product: string,
  category?: string,
  imageStyle?: string,
  colorHint?: string,
  imageQuery?: string
) {
  const qUser = (imageQuery || "").trim();
  const base = [product, category, imageStyle, colorHint].filter(Boolean).join(" ").trim();
  const queries = [
    qUser || base,
    [product, category, "product photo", imageStyle].filter(Boolean).join(" "),
    [product, category, "studio", "minimal"].filter(Boolean).join(" "),
  ].filter(Boolean) as string[];
  return Array.from(new Set(queries));
}

async function getPexelsPhotos(query: string, n: number): Promise<string[]> {
  if (!PEXELS_KEY) return [];
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Math.min(
      Math.max(n, 1),
      12
    )}&orientation=square`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY }, cache: "no-store" });
    if (!res.ok) return [];
    const j = (await res.json()) as PexelsSearch;
    const photos = j.photos || [];
    const urls = photos
      .map((p) => p?.src?.large2x || p?.src?.large || p?.src?.medium)
      .filter((u): u is string => !!u);
    return urls;
  } catch {
    return [];
  }
}

/* ========== MAIN HANDLER ========== */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenReq;
    const {
      product,
      category,
      keyBenefit,
      audience,
      tone,
      platform,
      imageStyle,
      colorHint,
      includeImage,
      imageQuery,
    } = body || {};

    if (!product) return NextResponse.json({ error: "Missing product" }, { status: 400 });

    // 1) Local, product-aware copy (no LLM)
    const { copy, debug } = composeCopy(product, category, keyBenefit, audience, tone, platform);

    // 2) Images (Pexels multi-candidates)
    const imgQueries = buildImageQueries(product, category, imageStyle, colorHint, imageQuery);
    let photoUrls: string[] = [];
    if (includeImage !== false) {
      for (const q of imgQueries) {
        const urls = await getPexelsPhotos(q, 6);
        photoUrls = photoUrls.concat(urls);
        if (photoUrls.length >= 6) break;
      }
      photoUrls = Array.from(new Set(photoUrls)).slice(0, 6);
    }

    // 3) Return
    return NextResponse.json(
      {
        provider: "local",
        demo: false,
        copy,
        imageDataUrl: null,
        photoUrls,
        debug, // visible so you can confirm changes per product
        note: "Local deterministic copy (LLM disabled).",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}