import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ------------ types ------------ */
type GenReq = {
  product: string;
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
const isVercel = process.env.VERCEL === "1";

/* ------------ helpers: copy + svg ------------ */
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

/* ------------ helpers: parsing ------------ */
// Extract first JSON object from messy text (handles ```json fences)
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

// Parse "Tagline: ..." lines if there was no JSON at all
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

// Accept alternate keys and coerce to StrictCopy
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

/* ------------ helpers: prompts + images ------------ */
function makeCopyPrompt(product: string, audience?: string, tone?: string, platform?: string) {
  return `
You are a marketing writer. Respond ONLY with a JSON object — no code fences, no markdown.
JSON schema:
{
  "tagline": string,         // <= 8 words, catchy
  "caption": string,         // <= 140 chars
  "shortDescription": string,// <= 3 sentences
  "hashtags": string[]       // 5 short tags, no spaces inside tags
}

Product: ${product}
Audience: ${audience || "general consumers"}
Tone: ${tone || "friendly"}
Platform: ${platform || "Instagram"}
`.trim();
}

function buildPhotoQuery(
  product: string,
  imageStyle?: string,
  colorHint?: string,
  imageQuery?: string
) {
  const q = imageQuery?.trim();
  if (q) return q;
  return [product, imageStyle, colorHint].filter(Boolean).join(" ").trim();
}

async function getPexelsPhotoUrl(query: string): Promise<string | null> {
  if (!PEXELS_KEY) return null;
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
      query
    )}&per_page=1&orientation=square`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY }, cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as PexelsSearch;
    const p = j.photos?.[0];
    return p?.src?.large2x || p?.src?.large || p?.src?.medium || null;
  } catch {
    return null;
  }
}

/* ------------ GROQ multi-try helper ------------ */
async function groqTry(product: string, audience?: string, tone?: string, platform?: string) {
  const key = process.env.GROQ_API_KEY!;
  const url = "https://api.groq.com/openai/v1/chat/completions";

  // Attempt 1 — normal JSON prompt
  const m1 = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      temperature: 0.85,
      messages: [
        { role: "system", content: "Return ONLY a JSON object. No code fences, no markdown." },
        { role: "user", content: makeCopyPrompt(product, audience, tone, platform) },
      ],
    }),
    cache: "no-store",
  }).then(r => r.json() as Promise<GroqChatResponse>).catch(() => ({} as GroqChatResponse));
  let raw = m1?.choices?.[0]?.message?.content || "";

  // Attempt 2 — stricter + few-shot if empty or {}
  if (!raw || raw.trim() === "{}") {
    const m2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        temperature: 0.9,
        messages: [
          { role: "system", content: "You are a strict JSON generator. Output ONE JSON object ONLY." },
          {
            role: "user",
            content:
              `Return EXACTLY this structure: {"tagline":"..","caption":"..","shortDescription":"..","hashtags":["#a","#b","#c","#d","#e"]}\n` +
              `Product: ${product}\nAudience: ${audience || "general consumers"}\nTone: ${tone || "friendly"}\nPlatform: ${platform || "Instagram"}`,
          },
          {
            role: "assistant",
            content:
              `{"tagline":"Bold mornings","caption":"Wake up right.","shortDescription":"A rich blend for everyday energy.","hashtags":["#coffee","#morning","#energy","#daily","#love"]}`,
          },
          { role: "user", content: "Now do the product above. JSON only." },
        ],
      }),
      cache: "no-store",
    }).then(r => r.json() as Promise<GroqChatResponse>).catch(() => ({} as GroqChatResponse));
    raw = m2?.choices?.[0]?.message?.content || raw;
  }

  // Attempt 3 — key/value lines (we’ll parse)
  if (!raw || raw.trim() === "{}") {
    const m3 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        temperature: 0.9,
        messages: [
          { role: "system", content: "Return ONLY plain text with these keys, no extra text." },
          {
            role: "user",
            content:
              `Tagline: ...\nCaption: ...\nShort Description: ...\nHashtags: #a #b #c #d #e\n\n` +
              `Product: ${product}\nAudience: ${audience || "general consumers"}\nTone: ${tone || "friendly"}\nPlatform: ${platform || "Instagram"}`,
          },
        ],
      }),
      cache: "no-store",
    }).then(r => r.json() as Promise<GroqChatResponse>).catch(() => ({} as GroqChatResponse));
    raw = m3?.choices?.[0]?.message?.content || raw;
  }

  return raw || "";
}

/* ------------ handler ------------ */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenReq;
    const {
      product,
      audience,
      tone,
      platform,
      imageStyle,
      colorHint,
      includeImage,
      imageQuery,
    } = body || {};
    if (!product) return NextResponse.json({ error: "Missing product" }, { status: 400 });

    const photoQuery = buildPhotoQuery(product, imageStyle, colorHint, imageQuery);

    /* ---- 1) OpenAI (cloud) ---- */
    if (HAS_OPENAI) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      try {
        const copyRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.9,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return only valid JSON, no markdown or code fences." },
            { role: "user", content: makeCopyPrompt(product, audience, tone, platform) },
          ],
        });

        const raw = copyRes.choices?.[0]?.message?.content || "{}";
        const parsed = extractJsonFromText(raw) ?? raw;
        const copy = coerceCopy(parsed, product);

        let imageDataUrl: string | null = null;
        if (includeImage !== false) {
          try {
            const img = await openai.images.generate({
              model: "gpt-image-1",
              prompt: `
Marketing poster for: ${product}.
Style: ${imageStyle || "clean, modern, minimal"}; Colors: ${colorHint || "brand neutral"}.
No text; product-centric; soft lighting; centered composition.
`,
              size: "512x512",
              response_format: "b64_json",
            });
            const b64 = img.data?.[0]?.b64_json;
            if (b64) imageDataUrl = `data:image/png;base64,${b64}`;
          } catch {
            // use stock
          }
        }
        const photoUrl = imageDataUrl || includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);

        return NextResponse.json(
          { provider: "openai", demo: false, copy, imageDataUrl, photoUrl, rawModelText: raw },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        // fall through
      }
    }

    /* ---- 1.5) Groq (cloud, free text) ---- */
    if (HAS_GROQ) {
      try {
        const raw = await groqTry(product, audience, tone, platform);

        // Try JSON first, else parse keyed lines, else fallback generator will run
        const parsed = extractJsonFromText(raw) ?? parseKeyedLines(raw) ?? raw;
        const copy = coerceCopy(parsed, product);

        const photoUrl = includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);

        return NextResponse.json(
          { provider: "groq", demo: false, copy, imageDataUrl: null, photoUrl, rawModelText: raw },
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
            prompt: makeCopyPrompt(product, audience, tone, platform),
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
              copy: MOCK_COPY(product),
              imageDataUrl: svg,
              photoUrl: null,
              message: "Ollama not ready or model too large. Try llama3.2:1b / phi3:mini.",
            },
            { headers: { "Cache-Control": "no-store" } }
          );
        }

        const j = (await res.json()) as { response?: string };
        const parsed = extractJsonFromText(j.response ?? "") ?? parseKeyedLines(j.response ?? "") ?? j.response ?? "";
        const copy = coerceCopy(parsed, product);
        const photoUrl = includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);

        return NextResponse.json(
          { provider: "ollama", demo: false, copy, imageDataUrl: null, photoUrl, rawModelText: j.response ?? "" },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        // fall through
      }
    }

    /* ---- 3) Demo fallback ---- */
    const svg = toDataUrlSvg(MOCK_SVG(product));
    const photoUrl = includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);
    return NextResponse.json(
      {
        provider: "demo",
        demo: true,
        copy: MOCK_COPY(product),
        imageDataUrl: svg,
        photoUrl,
        message: isVercel
          ? "No cloud key configured and Ollama is not reachable in production. Serving demo output."
          : "AI not available. Serving demo output.",
        rawModelText: "",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}