import { NextResponse } from "next/server";
import OpenAI from "openai";

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

type CopyShape = {
  tagline?: string;
  caption?: string;
  shortDescription?: string;
  hashtags?: string[] | string;
};
type StrictCopy = Required<Omit<CopyShape, "hashtags">> & { hashtags: string[] };

type PexelsPhoto = { src?: { large2x?: string; large?: string; medium?: string } };
type PexelsSearch = { photos?: PexelsPhoto[] };
type GroqChatResponse = { choices?: { message?: { content?: string } }[] };

/* ------------ env ------------ */
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_GROQ = !!process.env.GROQ_API_KEY;

const PROVIDER = process.env.AI_PROVIDER || (HAS_OPENAI ? "openai" : "ollama");
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:1b";
const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || "llama3-70b-8192"; // higher quality
const isVercel = process.env.VERCEL === "1";

/* ======== tiny utils ======== */
const clampWords = (s: string, n: number) => s.trim().split(/\s+/).slice(0, n).join(" ");
const firstWordTag = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "brand";
const slugParts = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

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

/* ======== fallback poster svg ======== */
const MOCK_SVG = (product: string) => {
  const txt = product.length > 28 ? product.slice(0, 28) + "…" : product;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#222"/><stop offset="1" stop-color="#666"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="512" cy="512" r="280" fill="#fff" opacity="0.08"/>
  <circle cx="680" cy="380" r="160" fill="#fff" opacity="0.05"/>
  <text x="50%" y="52%" text-anchor="middle" font-family="Inter, Arial, sans-serif"
        font-size="64" fill="#fff" opacity="0.95">${txt}</text>
</svg>`;
};
const toDataUrlSvg = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/* ======== LLM parsing ======== */
function extractJsonFromText(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?|```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function parseKeyedLines(text: string): CopyShape | null {
  if (!text) return null;
  const get = (re: RegExp) => (text.match(re)?.[1] || "").trim();
  const tagline = get(/tagline\s*:\s*([^\n]+)/i);
  const caption = get(/caption\s*:\s*([^\n]+)/i);
  const shortDescription = get(/short\s*description\s*:\s*([\s\S]*?)(?:\n\w+:|$)/i);
  const hashtagsRaw = get(/hashtags?\s*:\s*([^\n]+)/i);
  const hashtagsArr = hashtagsRaw
    ? hashtagsRaw.split(/[, ]+/).map(t => t.replace(/^#*/, "").trim()).filter(Boolean).map(t => `#${t}`)
    : [];
  if (!tagline && !caption && !shortDescription && hashtagsArr.length === 0) return null;
  return { tagline, caption, shortDescription, hashtags: hashtagsArr };
}
function coerceCopy(input: unknown, product: string): StrictCopy {
  const fallback: StrictCopy = {
    tagline: `Meet ${product}`,
    caption: `Say hello to ${product}! Fresh look, easy choice.`,
    shortDescription: `${product} is designed to delight.`,
    hashtags: ["#new", "#musthave", "#style", "#daily", "#love"]
  };

  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return undefined;
    };
    const tagline = pick("tagline", "title", "headline");
    const caption = pick("caption", "subtitle", "socialCaption");
    const shortDescription = pick("shortDescription", "short_description", "description", "blurb");
    let hashtags: string[] = [];
    const raw = o["hashtags"];
    if (Array.isArray(raw)) {
      hashtags = raw.map(t => (typeof t === "string" ? t : "")).filter(Boolean).map(t => t.replace(/^#*/, "")).map(t => `#${t}`);
    } else if (typeof raw === "string") {
      hashtags = raw.split(/[, ]+/).map(t => t.replace(/^#*/, "")).filter(Boolean).map(t => `#${t}`);
    }
    return {
      tagline: tagline || fallback.tagline,
      caption: caption || fallback.caption,
      shortDescription: shortDescription || fallback.shortDescription,
      hashtags: hashtags.length ? hashtags.slice(0, 5) : fallback.hashtags
    };
  }

  if (typeof input === "string") {
    const parsed = parseKeyedLines(input);
    if (parsed) return coerceCopy(parsed, product);
  }
  return fallback;
}

/* ======== quality checks ======== */
function ensureProductInTagline(copy: StrictCopy, product: string): StrictCopy {
  const p = product.trim();
  if (p && !copy.tagline.toLowerCase().includes(p.toLowerCase())) {
    copy.tagline = `${clampWords(p, 3)}: ${copy.tagline}`;
  }
  return copy;
}
function ensureHashtags(copy: StrictCopy, product: string, cat?: string): StrictCopy {
  const parts = slugParts(product).slice(0, 2);
  const set = new Set<string>(copy.hashtags.map(h => (h.startsWith("#") ? h : `#${h}`)));
  for (const part of parts) set.add(`#${part}`);
  set.add(categoryTag(cat));
  copy.hashtags = Array.from(set).slice(0, 5);
  return copy;
}
function looksGeneric(copy: StrictCopy, product: string, category?: string, benefit?: string): boolean {
  const p = product.trim().toLowerCase();
  const c = (category || "").trim().toLowerCase();
  const b = (benefit || "").trim().toLowerCase();
  const mentionsProduct = p && (copy.tagline.toLowerCase().includes(p) || copy.caption.toLowerCase().includes(p));
  const mentionsCatOrBenefit = (!!c && (copy.tagline.toLowerCase().includes(c) || copy.caption.toLowerCase().includes(c))) ||
                               (!!b && (copy.tagline.toLowerCase().includes(b) || copy.caption.toLowerCase().includes(b)));
  const tooShort = copy.tagline.split(/\s+/).length < 2 || copy.caption.split(/\s+/).length < 4;
  const templatey = copy.tagline.startsWith(`Meet ${product}`) || copy.caption.startsWith(`Say hello to ${product}`);
  return !mentionsProduct || !mentionsCatOrBenefit || tooShort || templatey;
}

/* ======== deterministic composer (never generic) ======== */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function pick<T>(arr: T[], seed: number, salt: number) { return arr[(seed + salt) % arr.length]; }

function composeCopy(
  product: string,
  category?: string,
  keyBenefit?: string,
  audience?: string,
  tone?: string,
  platform?: string
): StrictCopy {
  const seed = hashString([product, category, keyBenefit, audience, tone, platform].join("|"));
  const toneWords: Record<string, string[]> = {
    friendly: ["friendly", "easy", "everyday", "feel-good", "simple", "welcoming"],
    playful:  ["playful", "cheeky", "fun", "vibrant", "lively", "bright"],
    luxury:   ["luxury", "elegant", "refined", "premium", "polished", "sleek"],
    bold:     ["bold", "striking", "confident", "punchy", "dynamic", "powerful"],
    calm:     ["calm", "soft", "clean", "minimal", "subtle", "gentle"],
  };
  const verbs    = ["Discover", "Try", "Meet", "Enjoy", "Upgrade to", "Experience", "Unwrap", "Level up with"];
  const closers  = ["made for you", "built for daily life", "crafted with care", "designed to delight", "with zero fuss", "ready when you are"];
  const useCases = ["everyday use", "busy mornings", "weekend plans", "work & play", "on-the-go moments", "your routine"];
  const catBits: Record<string, string[]> = {
    beverage: ["refreshment", "flavor", "sips", "energy", "cool down", "brew"],
    skincare: ["glow", "hydration", "smoothness", "care", "routine", "radiance"],
    apparel:  ["comfort", "style", "fit", "layers", "everyday wear", "outfits"],
    gadget:   ["smarts", "power", "control", "speed", "simplicity", "connectivity"],
    pet:      ["tail wags", "purrs", "treat time", "cleanups", "happy bowls", "walks"],
    home:     ["coziness", "ease", "tidy spaces", "warmth", "every corner", "home life"],
    food:     ["flavor", "crunch", "protein", "snack time", "goodness", "bites"],
    other:    ["quality", "value", "joy", "fresh starts", "daily wins", "ease"],
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

  const pShort = clampWords(product, 4);
  const pParts = slugParts(product);
  const pEmph  = pParts.slice(0, 2).map(w => w[0]?.toUpperCase() + w.slice(1)).join(" ");

  const t1 = pick(tones, seed, 1);
  const t2 = pick(tones, seed, 2);
  const v  = pick(verbs, seed, 3);
  const c1 = pick(closers, seed, 4);
  const uc = pick(useCases, seed, 5);
  const catPhrase = pick(catBits[normCat], seed, 6);
  const benefit = (keyBenefit && keyBenefit.trim()) || pick(catBits[normCat], seed, 7);

  const templates = [
    { tl: clampWords(`${pShort}: ${t1} ${benefit}`, 8),
      cp: clampWords(`${v} ${pShort} — ${t2} ${benefit}, ${c1}.`, 26),
      sd: `${pShort} brings ${benefit} with a ${t1}, ${t2} feel. Perfect for ${audience || "everyone"} on ${platform || "social"}.` },
    { tl: clampWords(`${pEmph} • ${benefit} ${normCat !== "other" ? "for " + normCat : ""}`, 8),
      cp: clampWords(`${v} ${pShort} and feel the ${catPhrase}. Built for ${uc}.`, 26),
      sd: `Made to deliver ${benefit} without the guesswork. ${pShort} fits right into ${audience || "your"} routine.` },
    { tl: clampWords(`${pShort}: ${catPhrase}, ${benefit}`, 8),
      cp: clampWords(`${v} the ${t1} choice — ${pShort} keeps ${uc} simple.`, 26),
      sd: `${pShort} focuses on ${benefit}. A ${t2} touch that works across ${platform || "every platform"}.` },
  ];
  const pickT = templates[seed % templates.length];

  const tags = new Set<string>([
    `#${firstWordTag(product)}`,
    categoryTag(category).toLowerCase(),
    `#${(benefit || catPhrase).toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
    "#new",
    "#daily",
  ]);

  return {
    tagline: pickT.tl,
    caption: pickT.cp,
    shortDescription: pickT.sd,
    hashtags: Array.from(tags).slice(0, 5),
  };
}

/* ======== images (Pexels multi-candidates) ======== */
function buildImageQueries(product: string, category?: string, imageStyle?: string, colorHint?: string, imageQuery?: string) {
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
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Math.min(Math.max(n,1),12)}&orientation=square`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY }, cache: "no-store" });
    if (!res.ok) return [];
    const j = (await res.json()) as PexelsSearch;
    const photos = j.photos || [];
    return photos.map(p => p?.src?.large2x || p?.src?.large || p?.src?.medium).filter((u): u is string => !!u);
  } catch { return []; }
}

/* ======== Groq helper (try multiple models, low temp) ======== */
async function groqJSON(product: string, category?: string, keyBenefit?: string, audience?: string, tone?: string, platform?: string) {
  const key = process.env.GROQ_API_KEY!;
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const models = [
    DEFAULT_GROQ_MODEL,              // e.g., llama3-70b-8192
    "llama3-8b-8192",
    "mixtral-8x7b-32768",
  ];
  const messages = [
    { role: "system", content: "Return ONLY a JSON object. No code fences, no markdown." },
    { role: "user", content: `
You are a precise marketing writer. Do NOT invent ingredients, specs, numbers, or health claims.

Return ONLY a JSON object (no markdown). Schema:
{
  "tagline": string,          // <= 8 words, must reference the product or category
  "caption": string,          // <= 140 chars, 1 sentence
  "shortDescription": string, // <= 3 short sentences, no invented facts
  "hashtags": string[]        // 5 tags, short; include a product & category-related tag if possible
}

Inputs:
- product: ${product}
- category: ${category || "unspecified"}
- key benefit: ${keyBenefit || "unspecified"}
- audience: ${audience || "general consumers"}
- tone: ${tone || "friendly"}
- platform: ${platform || "Instagram"}

Constraints:
- Mention the product or its category in the tagline.
- Hashtags: short, lowercase, no spaces; 5 total.
`.trim() }
  ];

  for (const model of models) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.5, messages }), // lower temp => on-topic
        cache: "no-store",
      });
      const j = (await r.json()) as GroqChatResponse;
      const raw = j?.choices?.[0]?.message?.content?.trim() ?? "";
      if (raw) return raw;
    } catch { /* try next model */ }
  }
  return "";
}

/* ========== MAIN HANDLER ========== */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenReq;
    const { product, category, keyBenefit, audience, tone, platform, imageStyle, colorHint, includeImage, imageQuery } = body || {};
    if (!product) return NextResponse.json({ error: "Missing product" }, { status: 400 });

    // 0) Always build solid, product-aware copy locally first
    let copy: StrictCopy = composeCopy(product, category, keyBenefit, audience, tone, platform);
    let provider: "openai" | "groq" | "ollama" | "demo" = "demo";
    let rawModelText = "";

    // 1) Try OpenAI (if configured). Accept only if passes relevance.
    if (HAS_OPENAI) {
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
        const res = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.6,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return only valid JSON, no markdown or code fences." },
            { role: "user", content: `
You are a precise marketing writer. Do NOT invent ingredients, specs, numbers, or health claims.

Return ONLY a JSON object with keys: tagline, caption, shortDescription, hashtags (5 items).
The tagline must reference the product or category. The caption should be <= 140 chars.
Product: ${product}; Category: ${category || "unspecified"}; Benefit: ${keyBenefit || "unspecified"};
Audience: ${audience || "general consumers"}; Tone: ${tone || "friendly"}; Platform: ${platform || "Instagram"}.
`.trim() },
          ],
        });
        const raw = res.choices?.[0]?.message?.content || "";
        rawModelText = raw;
        const parsed = extractJsonFromText(raw) ?? parseKeyedLines(raw) ?? raw;
        const candidate = coerceCopy(parsed, product);
        const enforced = ensureHashtags(ensureProductInTagline(candidate, product), product, category);
        if (!looksGeneric(enforced, product, category, keyBenefit)) {
          copy = enforced;
          provider = "openai";
        }
      } catch { /* move on */ }
    }

    // 2) Try Groq (if still on demo). Accept only if passes relevance.
    if (provider === "demo" && HAS_GROQ) {
      try {
        const raw = await groqJSON(product, category, keyBenefit, audience, tone, platform);
        rawModelText = raw || rawModelText;
        const parsed = extractJsonFromText(raw) ?? parseKeyedLines(raw) ?? raw;
        const candidate = coerceCopy(parsed, product);
        const enforced = ensureHashtags(ensureProductInTagline(candidate, product), product, category);
        if (!looksGeneric(enforced, product, category, keyBenefit)) {
          copy = enforced;
          provider = "groq";
        }
      } catch { /* ignore */ }
    }

    // 3) Optional: Ollama (local dev only; we still keep composed unless it passes)
    if (!isVercel && PROVIDER === "ollama" && provider === "demo") {
      try {
        const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: `Return ONLY JSON: {"tagline":"..","caption":"..","shortDescription":"..","hashtags":["#a","#b","#c","#d","#e"]}\nProduct:${product}; Category:${category}; Benefit:${keyBenefit}; Audience:${audience}; Tone:${tone}; Platform:${platform}`,
            stream: false,
            options: { num_ctx: 512, num_predict: 256 },
          }),
          cache: "no-store",
        });
        if (r.ok) {
          const j = (await r.json()) as { response?: string };
          rawModelText = j.response || rawModelText;
          const parsed = extractJsonFromText(j.response ?? "") ?? parseKeyedLines(j.response ?? "") ?? j.response ?? "";
          const candidate = coerceCopy(parsed, product);
          const enforced = ensureHashtags(ensureProductInTagline(candidate, product), product, category);
          if (!looksGeneric(enforced, product, category, keyBenefit)) {
            copy = enforced;
            provider = "ollama";
          }
        }
      } catch {}
    }

    // 4) Images (Pexels multi-candidates; you said this is perfect)
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

    // 5) Return
    return NextResponse.json(
      {
        provider,
        demo: provider === "demo",
        copy,
        imageDataUrl: null,
        photoUrls,
        rawModelText,
        note: provider === "demo"
          ? "Model output looked generic; using deterministic product-aware copy."
          : "Model output passed relevance checks.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}