import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ------------ request & data types ------------ */
type GenReq = {
  product: string;
  category?: string;     // e.g., "Beverage", "Skincare"
  keyBenefit?: string;   // e.g., "smoother skin"
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
const GROQ_MODEL = process.env.GROQ_MODEL || "mixtral-8x7b-32768";
const isVercel = process.env.VERCEL === "1";

/* ------------ small utils ------------ */
const clampWords = (s: string, maxWords: number) =>
  s.split(/\s+/).slice(0, maxWords).join(" ").trim();

const firstWordTag = (s: string) =>
  s.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "brand";

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

/* ------------ fallback copy + svg ------------ */
const MOCK_COPY = (product: string): StrictCopy => ({
  tagline: `Meet ${product}`,
  caption: `Say hello to ${product}! Fresh look, easy choice.`,
  shortDescription: `${product} is designed to delight. Crafted with care and ready to impress—perfect for everyday use.`,
  hashtags: ["#new", "#musthave", "#style", "#daily", "#love"],
});

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
const toDataUrlSvg = (svg: string) =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/* ------------ parsing helpers ------------ */
function extractJsonFromText(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?|```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function parseKeyedLines(text: string): CopyShape | null {
  if (!text) return null;
  const get = (re: RegExp) => (text.match(re)?.[1] || "").trim();
  const tagline = get(/tagline\s*:\s*([^\n]+)/i);
  const caption = get(/caption\s*:\s*([^\n]+)/i);
  const shortDescription = get(/short\s*description\s*:\s*([\s\S]*?)(?:\n\w+:|$)/i);
  const hashtagsRaw = get(/hashtags?\s*:\s*([^\n]+)/i);
  const hashtagsArr = hashtagsRaw
    ? hashtagsRaw
        .split(/[, ]+/)
        .map((t) => t.replace(/^#*/, "").trim())
        .filter(Boolean)
        .map((t) => `#${t}`)
    : [];
  if (!tagline && !caption && !shortDescription && hashtagsArr.length === 0) return null;
  return { tagline, caption, shortDescription, hashtags: hashtagsArr };
}

function coerceCopy(input: unknown, product: string): StrictCopy {
  const fallback = MOCK_COPY(product);

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
      hashtags = raw
        .map((t) => (typeof t === "string" ? t : ""))
        .filter(Boolean)
        .map((t) => t.replace(/^#*/, ""))
        .map((t) => `#${t}`);
    } else if (typeof raw === "string") {
      hashtags = raw
        .split(/[, ]+/)
        .map((t) => t.replace(/^#*/, ""))
        .filter(Boolean)
        .map((t) => `#${t}`);
    }

    return {
      tagline: tagline || fallback.tagline,
      caption: caption || fallback.caption,
      shortDescription: shortDescription || fallback.shortDescription,
      hashtags: hashtags.length ? hashtags.slice(0, 5) : fallback.hashtags,
    };
  }

  if (typeof input === "string") {
    const parsed = parseKeyedLines(input);
    if (parsed) return coerceCopy(parsed, product);
  }
  return fallback;
}

/* ------------ “good enough?” checks & enforcement ------------ */
function ensureProductInTagline(copy: StrictCopy, product: string): StrictCopy {
  const p = product.trim();
  if (p && !copy.tagline.toLowerCase().includes(p.toLowerCase())) {
    copy.tagline = `${clampWords(p, 3)}: ${copy.tagline}`;
  }
  return copy;
}
function ensureHashtags(copy: StrictCopy, product: string, cat?: string): StrictCopy {
  const firstTag = firstWordTag(product);
  const catTag = categoryTag(cat);
  const set = new Set<string>(copy.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)));
  set.add(`#${firstTag}`);
  set.add(catTag);
  copy.hashtags = Array.from(set).slice(0, 5);
  return copy;
}
function looksGeneric(copy: StrictCopy, product: string): boolean {
  const p = product.trim();
  const genericStarts =
    copy.tagline.startsWith(`Meet ${p}`) ||
    copy.caption.startsWith(`Say hello to ${p}`);
  const tooShort = copy.tagline.split(/\s+/).length < 2 || copy.caption.split(/\s+/).length < 4;
  return genericStarts || tooShort;
}

/* ------------ deterministic, product-aware fallback composer ------------ */
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

function composeFallbackCopy(product: string, category?: string, keyBenefit?: string, audience?: string, tone?: string, platform?: string): StrictCopy {
  const seed = hashString([product, category, keyBenefit, audience, tone, platform].join("|"));
  const adjTone: Record<string, string[]> = {
    friendly: ["friendly", "easy", "everyday", "feel-good", "simple"],
    playful: ["playful", "cheeky", "fun", "vibrant", "lively"],
    luxury:  ["luxury", "elegant", "refined", "premium", "polished"],
    bold:    ["bold", "striking", "confident", "punchy", "dynamic"],
    calm:    ["calm", "soft", "clean", "minimal", "subtle"],
  };
  const verbs = ["Discover", "Try", "Meet", "Enjoy", "Upgrade to", "Say hello to", "Treat yourself to"];
  const closers = ["made for you", "built for daily life", "crafted with care", "designed to delight", "with zero fuss"];
  const catPhrases: Record<string, string[]> = {
    beverage: ["refreshment", "flavor", "sips", "energy", "cool down"],
    skincare: ["glow", "hydration", "smoothness", "care", "routine"],
    apparel:  ["comfort", "style", "fit", "layers", "everyday wear"],
    gadget:   ["smarts", "power", "control", "speed", "simplicity"],
    pet:      ["tail wags", "purrs", "happy bowls", "cleanups", "treat time"],
    home:     ["coziness", "ease", "tidy spaces", "warmth", "every corner"],
    food:     ["flavor", "crunch", "protein", "snack time", "goodness"],
    other:    ["quality", "value", "joy", "fresh starts", "daily wins"],
  };

  const normCat = (() => {
    const c = (category || "").toLowerCase();
    if (/(beverage|drink|coffee|tea|brew)/.test(c)) return "beverage";
    if (/(skincare|skin|beauty|serum|cream)/.test(c)) return "skincare";
    if (/(apparel|fashion|clothing|wear)/.test(c)) return "apparel";
    if (/(gadget|tech|device|electronics)/.test(c)) return "gadget";
    if (/pet/.test(c)) return "pet";
    if (/home/.test(c)) return "home";
    if (/food|snack|granola|protein/.test(c)) return "food";
    return "other";
  })();

  const toneKey = (tone || "friendly").toLowerCase();
  const tones = adjTone[toneKey] || adjTone["friendly"];

  const pWord = clampWords(product, 4);
  const benefit = keyBenefit?.trim() || pick(catPhrases[normCat], seed, 7);
  const t1 = pick(tones, seed, 1);
  const t2 = pick(tones, seed, 2);
  const v  = pick(verbs, seed, 3);
  const c1 = pick(closers, seed, 4);
  const catPhrase = pick(catPhrases[normCat], seed, 5);

  const tagline = clampWords(`${pWord}: ${t1} ${benefit}`, 8);
  const caption = clampWords(`${v} ${pWord} — ${t2} ${benefit}, ${c1}.`, 22);
  const shortDescription = `${pWord} brings ${benefit} with a ${t1}, ${t2} feel. Perfect for ${audience || "everyday use"} on ${platform || "social"}.`;
  const hashtags = [
    `#${firstWordTag(product)}`,
    categoryTag(category).toLowerCase(),
    `#${(benefit || catPhrase).toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
    "#new",
    "#daily",
  ];

  return { tagline, caption, shortDescription, hashtags };
}

/* ------------ prompt + images ------------ */
function makeCopyPrompt(
  product: string,
  category?: string,
  keyBenefit?: string,
  audience?: string,
  tone?: string,
  platform?: string
) {
  return `
You are a precise marketing writer. Use ONLY the info provided; do NOT invent ingredients, specs, materials, numbers, or health claims. Keep it truthful and generic if unsure.

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
- Avoid specifics not provided (no ingredients, no tech specs, no medical claims).
- Hashtags: short, lowercase, no spaces; 5 total.
`.trim();
}

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

/* ------------ GROQ multi-try (consistent shape) ------------ */
type GroqMsg = { role: "system" | "user" | "assistant"; content: string };

async function groqTry(
  product: string,
  category?: string,
  keyBenefit?: string,
  audience?: string,
  tone?: string,
  platform?: string
) {
  const key = process.env.GROQ_API_KEY!;
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const prompts: { temperature: number; fewshot: boolean; lines: boolean }[] = [
    { temperature: 0.8,  fewshot: false, lines: false },
    { temperature: 0.9,  fewshot: true,  lines: false },
    { temperature: 0.95, fewshot: false, lines: true  },
  ];

  let raw = "";

  for (const p of prompts) {
    const messages: GroqMsg[] = [];

    if (!p.lines) {
      messages.push({
        role: "system",
        content: "Return ONLY a JSON object. No code fences, no markdown."
      });
      messages.push({
        role: "user",
        content: makeCopyPrompt(product, category, keyBenefit, audience, tone, platform)
      });
      if (p.fewshot) {
        messages.push({
          role: "assistant",
          content:
            `{"tagline":"Bold mornings","caption":"Wake up right.","shortDescription":"A rich blend for everyday energy.","hashtags":["#coffee","#morning","#energy","#daily","#love"]}`
        });
        messages.push({ role: "user", content: "Now do the product above. JSON only." });
      }
    } else {
      messages.push({
        role: "system",
        content: "Return ONLY plain text lines with these keys, no extra text."
      });
      messages.push({
        role: "user",
        content:
          `Tagline: ...\nCaption: ...\nShort Description: ...\nHashtags: #a #b #c #d #e\n\n` +
          `product: ${product}\ncategory: ${category || "unspecified"}\nbenefit: ${keyBenefit || "unspecified"}\n` +
          `audience: ${audience || "general"}\ntone: ${tone || "friendly"}\nplatform: ${platform || "Instagram"}`
      });
    }

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: GROQ_MODEL, temperature: p.temperature, messages }),
        cache: "no-store"
      });
      const j = (await r.json()) as GroqChatResponse;
      const candidate = j?.choices?.[0]?.message?.content?.trim() ?? "";
      if (candidate && candidate !== "{}") {
        raw = candidate;
        break;
      }
    } catch {
      // try next config
    }
  }

  return raw || "";
}

/* ------------ handler ------------ */
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

    const imgQueries = buildImageQueries(product, category, imageStyle, colorHint, imageQuery);

    // Helper to finalize copy (enforce product mention & tags, and upgrade generic)
    const finalize = (copyIn: StrictCopy): StrictCopy => {
      let copy = ensureProductInTagline(copyIn, product);
      copy = ensureHashtags(copy, product, category);
      if (looksGeneric(copy, product)) {
        copy = composeFallbackCopy(product, category, keyBenefit, audience, tone, platform);
      }
      return copy;
    };

    /* ---- 1) OpenAI (cloud) ---- */
    if (HAS_OPENAI) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      try {
        const copyRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.85,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return only valid JSON, no markdown or code fences." },
            { role: "user", content: makeCopyPrompt(product, category, keyBenefit, audience, tone, platform) },
          ],
        });

        const raw = copyRes.choices?.[0]?.message?.content || "{}";
        const parsed = extractJsonFromText(raw) ?? raw;
        const copy = finalize(coerceCopy(parsed, product));

        let imageDataUrl: string | null = null;
        if (includeImage !== false) {
          try {
            const img = await openai.images.generate({
              model: "gpt-image-1",
              prompt: `
Marketing poster for: ${product}.
Category: ${category || "unspecified"}; Benefit: ${keyBenefit || "unspecified"}.
Style: ${imageStyle || "clean, modern, minimal"}; Colors: ${colorHint || "brand neutral"}.
No text; product-centric; soft lighting; centered composition.
`,
              size: "512x512",
              response_format: "b64_json",
            });
            const b64 = img.data?.[0]?.b64_json;
            if (b64) imageDataUrl = `data:image/png;base64,${b64}`;
          } catch {}
        }

        let photoUrls: string[] = [];
        if (includeImage !== false) {
          for (const q of imgQueries) {
            const urls = await getPexelsPhotos(q, 6);
            photoUrls = photoUrls.concat(urls);
            if (photoUrls.length >= 6) break;
          }
          photoUrls = Array.from(new Set(photoUrls)).slice(0, 6);
        }

        return NextResponse.json(
          { provider: "openai", demo: false, copy, imageDataUrl, photoUrls, rawModelText: raw },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        // fall through
      }
    }

    /* ---- 1.5) Groq (cloud) ---- */
    if (HAS_GROQ) {
      try {
        const raw = await groqTry(product, category, keyBenefit, audience, tone, platform);
        const parsed = extractJsonFromText(raw) ?? parseKeyedLines(raw) ?? raw;
        const copy = finalize(coerceCopy(parsed, product));

        let photoUrls: string[] = [];
        if (includeImage !== false) {
          for (const q of imgQueries) {
            const urls = await getPexelsPhotos(q, 6);
            photoUrls = photoUrls.concat(urls);
            if (photoUrls.length >= 6) break;
          }
          photoUrls = Array.from(new Set(photoUrls)).slice(0, 6);
        }

        return NextResponse.json(
          { provider: "groq", demo: false, copy, imageDataUrl: null, photoUrls, rawModelText: raw },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        // continue
      }
    }

    /* ---- 2) Ollama (local dev only) ---- */
    if (!isVercel && PROVIDER === "ollama") {
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: makeCopyPrompt(product, category, keyBenefit, audience, tone, platform),
            stream: false,
            options: { num_ctx: 512, num_predict: 256 },
          }),
          cache: "no-store",
        });

        if (!res.ok) {
          const svg = toDataUrlSvg(MOCK_SVG(product));
          return NextResponse.json(
            {
              provider: "ollama",
              demo: true,
              copy: composeFallbackCopy(product, category, keyBenefit, audience, tone, platform),
              imageDataUrl: svg,
              photoUrls: [],
              message: "Ollama not ready or model too large. Try llama3.2:1b / phi3:mini.",
            },
            { headers: { "Cache-Control": "no-store" } }
          );
        }

        const j = (await res.json()) as { response?: string };
        const parsed = extractJsonFromText(j.response ?? "") ?? parseKeyedLines(j.response ?? "") ?? j.response ?? "";
        const copy = composeFallbackCopy(product, category, keyBenefit, audience, tone, platform); // deterministic & product-aware

        let photoUrls: string[] = [];
        if (includeImage !== false) {
          for (const q of imgQueries) {
            const urls = await getPexelsPhotos(q, 6);
            photoUrls = photoUrls.concat(urls);
            if (photoUrls.length >= 6) break;
          }
          photoUrls = Array.from(new Set(photoUrls)).slice(0, 6);
        }

        return NextResponse.json(
          { provider: "ollama", demo: false, copy, imageDataUrl: null, photoUrls, rawModelText: j.response ?? "" },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        // fall through
      }
    }

    /* ---- 3) Demo fallback ---- */
    const svg = toDataUrlSvg(MOCK_SVG(product));
    let photoUrls: string[] = [];
    if (imageQuery || PEXELS_KEY) {
      for (const q of imgQueries) {
        const urls = await getPexelsPhotos(q, 6);
        photoUrls = photoUrls.concat(urls);
        if (photoUrls.length >= 6) break;
      }
      photoUrls = Array.from(new Set(photoUrls)).slice(0, 6);
    }
    const copy = composeFallbackCopy(product, category, keyBenefit, audience, tone, platform);

    return NextResponse.json(
      {
        provider: "demo",
        demo: true,
        copy,
        imageDataUrl: svg,
        photoUrls,
        message: isVercel
          ? "No cloud key configured and Ollama is not reachable in production. Serving deterministic copy."
          : "AI not available. Serving deterministic copy.",
        rawModelText: "",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}