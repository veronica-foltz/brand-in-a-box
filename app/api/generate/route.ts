import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;

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
  hashtags?: string[];
};
type StrictCopy = Required<CopyShape>;

type PexelsPhoto = { src?: { large2x?: string; large?: string; medium?: string } };
type PexelsSearch = { photos?: PexelsPhoto[] };

type GroqChatResponse = { choices?: { message?: { content?: string } }[] };

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_GROQ = !!process.env.GROQ_API_KEY;

const PROVIDER = process.env.AI_PROVIDER || (HAS_OPENAI ? "openai" : "ollama");
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:1b";

const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const isVercel = process.env.VERCEL === "1";

// ---------- helpers ----------
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
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#222"/>
      <stop offset="1" stop-color="#666"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="512" cy="512" r="280" fill="#fff" opacity="0.08"/>
  <circle cx="680" cy="380" r="160" fill="#fff" opacity="0.05"/>
  <text x="50%" y="52%" text-anchor="middle"
        font-family="Inter, Arial, sans-serif" font-size="64"
        fill="#ffffff" opacity="0.95">${txt}</text>
</svg>`;
};

function toDataUrlSvg(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Pull the first {...} JSON block from free-form text
function extractJsonFromText(text: string): unknown | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// Validate the Copy shape
function isCopyShape(x: unknown): x is CopyShape {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const okStr = (v: unknown) => v === undefined || typeof v === "string";
  const okArr =
    !("hashtags" in o) ||
    (Array.isArray(o.hashtags) &&
      (o.hashtags as unknown[]).every((t) => typeof t === "string"));
  return okStr(o.tagline) && okStr(o.caption) && okStr(o.shortDescription) && okArr;
}

function normalizeCopy(input: unknown, product: string): StrictCopy {
  const fallback = MOCK_COPY(product);
  if (!isCopyShape(input)) return fallback;
  return {
    tagline: input.tagline ?? fallback.tagline,
    caption: input.caption ?? fallback.caption,
    shortDescription: input.shortDescription ?? fallback.shortDescription,
    hashtags:
      Array.isArray(input.hashtags) && input.hashtags.length > 0
        ? input.hashtags.slice(0, 5)
        : fallback.hashtags,
  };
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
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (!res.ok) return null;
    const j = (await res.json()) as PexelsSearch;
    const p = j.photos?.[0];
    return p?.src?.large2x || p?.src?.large || p?.src?.medium || null;
  } catch {
    return null;
  }
}

// ---------- handler ----------
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

    // 1) OpenAI (cloud)
    if (HAS_OPENAI) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      try {
        const copyPrompt = `
Return ONLY JSON with keys:
- "tagline" (<=8 words)
- "caption" (<=140 chars)
- "shortDescription" (<=3 sentences)
- "hashtags" (array of 5 short tags)

Product: ${product}
Audience: ${audience || "general consumers"}
Tone: ${tone || "friendly"}
Platform: ${platform || "Instagram"}
`;

        const copyRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.7,
          messages: [
            { role: "system", content: "Return only valid JSON, no commentary." },
            { role: "user", content: copyPrompt },
          ],
        });

        const raw = copyRes.choices?.[0]?.message?.content || "{}";
        const parsed = (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })();
        const copy = normalizeCopy(parsed, product);

        let imageDataUrl: string | null = null;
        if (includeImage !== false) {
          try {
            const imgPrompt = `
High-quality marketing poster for: ${product}.
Style: ${imageStyle || "clean, modern, minimal"}
Primary colors hint: ${colorHint || "brand neutral"}
No words on the image; product-focused visuals; centered composition; soft shadows.
`;
            const img = await openai.images.generate({
              model: "gpt-image-1",
              prompt: imgPrompt,
              size: "512x512",
              response_format: "b64_json",
            });
            const b64 = img.data?.[0]?.b64_json;
            if (b64) imageDataUrl = `data:image/png;base64,${b64}`;
          } catch {
            // ignore; we'll use stock photo
          }
        }

        const photoUrl =
          imageDataUrl || includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);

        return NextResponse.json({
          provider: "openai",
          demo: false,
          copy,
          imageDataUrl,
          photoUrl,
        });
      } catch {
        // fall through
      }
    }

    // 1.5) Groq (cloud, free text) – image via stock photo
    if (HAS_GROQ) {
      try {
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY!}`,
          },
          body: JSON.stringify({
            model: "llama3-8b-8192",
            temperature: 0.7,
            messages: [
              { role: "system", content: "Return only valid JSON, no commentary." },
              {
                role: "user",
                content: `
Return ONLY JSON with keys:
- "tagline" (<=8 words)
- "caption" (<=140 chars)
- "shortDescription" (<=3 sentences)
- "hashtags" (array of 5 short tags)

Product: ${product}
Audience: ${audience || "general consumers"}
Tone: ${tone || "friendly"}
Platform: ${platform || "Instagram"}
`,
              },
            ],
          }),
        });

        const j = (await groqRes.json()) as GroqChatResponse;
        const raw = j.choices?.[0]?.message?.content || "{}";

        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }

        const copy = normalizeCopy(parsed, product);
        const photoUrl =
          includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);

        return NextResponse.json({
          provider: "groq",
          demo: false,
          copy,
          imageDataUrl: null,
          photoUrl,
        });
      } catch {
        // continue
      }
    }

    // 2) Ollama (local dev only)
    if (!isVercel && PROVIDER === "ollama") {
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: `
Return ONLY JSON with keys:
- "tagline" (<=8 words)
- "caption" (<=140 chars)
- "shortDescription" (<=3 sentences)
- "hashtags" (array of 5 short tags)

Product: ${product}
Audience: ${audience || "general consumers"}
Tone: ${tone || "friendly"}
Platform: ${platform || "Instagram"}
`,
            stream: false,
            options: { num_ctx: 512, num_predict: 256 },
          }),
        });

        if (!res.ok) {
          const svg = toDataUrlSvg(MOCK_SVG(product));
          return NextResponse.json({
            provider: "ollama",
            demo: true,
            copy: MOCK_COPY(product),
            imageDataUrl: svg,
            photoUrl: null,
            message:
              "Ollama not ready or model too large. Try a tiny model (llama3.2:1b, phi3:mini).",
          });
        }

        const j = (await res.json()) as { response?: string };
        const textRaw = j.response ?? "";
        const parsed = extractJsonFromText(textRaw);
        const copy = normalizeCopy(parsed, product);

        const photoUrl =
          includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);

        return NextResponse.json({
          provider: "ollama",
          demo: false,
          copy,
          imageDataUrl: null,
          photoUrl,
        });
      } catch {
        // fall through
      }
    }

    // 3) Demo fallback
    const svg = toDataUrlSvg(MOCK_SVG(product));
    const photoUrl =
      includeImage === false ? null : await getPexelsPhotoUrl(photoQuery);
    return NextResponse.json({
      provider: "demo",
      demo: true,
      copy: MOCK_COPY(product),
      imageDataUrl: svg,
      photoUrl,
      message:
        isVercel
          ? "No cloud key configured and Ollama is not reachable in production. Serving demo output."
          : "AI not available. Serving demo output.",
    });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}