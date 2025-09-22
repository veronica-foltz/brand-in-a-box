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
};

type CopyShape = {
  tagline?: string;
  caption?: string;
  shortDescription?: string;
  hashtags?: string[];
};

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const PROVIDER = process.env.AI_PROVIDER || (HAS_OPENAI ? "openai" : "ollama");
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
const isVercel = process.env.VERCEL === "1";

// ---------- helpers ----------
const MOCK_COPY = (product: string): Required<CopyShape> => ({
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
        fill="#ffffff" opacity="0.95">
    ${txt}
  </text>
</svg>`;
};

function toDataUrlSvg(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Grab the first {...} from text (Ollama sometimes wraps JSON in chatter)
function extractJsonFromText(text: string): any | null {
  const m = text?.match?.(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// Ensure the copy object has all required fields (never blank on UI)
function normalizeCopy(input: any, product: string): Required<CopyShape> {
  const fallback = MOCK_COPY(product);
  const out: Required<CopyShape> = {
    tagline: input?.tagline || fallback.tagline,
    caption: input?.caption || fallback.caption,
    shortDescription: input?.shortDescription || fallback.shortDescription,
    hashtags:
      Array.isArray(input?.hashtags) && input.hashtags.length
        ? input.hashtags.slice(0, 5)
        : fallback.hashtags,
  };
  return out;
}

// ---------- handler ----------
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenReq;
    const { product, audience, tone, platform, imageStyle, colorHint } = body || {};
    if (!product) {
      return NextResponse.json({ error: "Missing product" }, { status: 400 });
    }

    // 1) OpenAI (if key present)
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
          try { return JSON.parse(raw); } catch { return null; }
        })();

        const copy = normalizeCopy(parsed, product);

        // Try image (if you have credits). If it fails, we just return null.
        let imageDataUrl: string | null = null;
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
          // leave imageDataUrl as null (UI will handle fallback)
        }

        return NextResponse.json({
          provider: "openai",
          demo: false,
          copy,
          imageDataUrl,
        });
      } catch {
        // continue to Ollama/demo
      }
    }

    // 2) Ollama (local; skip on Vercel)
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
          }),
        });

        // If Ollama responds with an error or not 200 → demo fallback
        if (!res.ok) {
          const svg = toDataUrlSvg(MOCK_SVG(product));
          return NextResponse.json({
            provider: "ollama",
            demo: true,
            copy: MOCK_COPY(product),
            imageDataUrl: svg,
            message:
              "Ollama not ready. Did you run `ollama pull llama3` and keep the service running?",
          });
        }

        const j = await res.json();
        const textRaw: string = j?.response;
        if (!textRaw) {
          const svg = toDataUrlSvg(MOCK_SVG(product));
          return NextResponse.json({
            provider: "ollama",
            demo: true,
            copy: MOCK_COPY(product),
            imageDataUrl: svg,
            message:
              "Ollama returned no response. Try `ollama run llama3` once to warm up the model.",
          });
        }

        const parsed = extractJsonFromText(textRaw);
        const copy = normalizeCopy(parsed, product);

        return NextResponse.json({
          provider: "ollama",
          demo: false,
          copy,
          imageDataUrl: null, // UI will choose a photo or SVG fallback
        });
      } catch {
        // fall through to demo
      }
    }

    // 3) Demo mode (always works)
    const svg = toDataUrlSvg(MOCK_SVG(product));
    return NextResponse.json({
      provider: "demo",
      demo: true,
      copy: MOCK_COPY(product),
      imageDataUrl: svg,
      message:
        isVercel
          ? "No cloud key configured and Ollama is not reachable in production. Serving demo output."
          : "AI not available. Serving demo output.",
    });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}