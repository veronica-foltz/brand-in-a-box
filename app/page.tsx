"use client";

import { useMemo, useState, useEffect } from "react";

type GenResult = {
  provider?: "openai" | "ollama" | "demo";
  demo?: boolean;
  copy?: {
    tagline?: string;
    caption?: string;
    shortDescription?: string;
    hashtags?: string[];
  };
  imageDataUrl?: string | null;
  message?: string;
  error?: string;
};

function placeholderSvgDataUrl(product: string) {
  const label = (product || "Your product").slice(0, 28);
  const svg = `
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
        fill="#ffffff" opacity="0.95">${label}</text>
</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export default function Home() {
  const [product, setProduct] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("friendly");
  const [platform, setPlatform] = useState("Instagram");
  const [imageStyle, setImageStyle] = useState("clean, modern, minimal");
  const [colorHint, setColorHint] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, audience, tone, platform, imageStyle, colorHint }),
      });
      const data: GenResult = await res.json();
      if (!res.ok) throw new Error(data?.error || "Server error");
      setResult(data);
    } catch (err: any) {
      setError(err.message || "Failed");
    } finally {
      setLoading(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text || "");
    alert("Copied!");
  }

  // Build a cascade of poster sources:
  const fallbacks = useMemo(() => {
    const topic = encodeURIComponent(product || "product");
    const tags = encodeURIComponent((product || "product").replace(/\s+/g, ","));
    return [
      // 1) Real PNG from OpenAI 
      result?.provider === "openai" && result?.imageDataUrl ? result.imageDataUrl : null,
      // 2) Unsplash topic photo 
      `https://source.unsplash.com/1024x1024/?${topic}`,
      // 3) LoremFlickr topic photo
      `https://loremflickr.com/1024/1024/${tags}`,
      // 4) Picsum seeded photo
      `https://picsum.photos/seed/${topic}/1024/1024`,
      // 5) Final guaranteed placeholder
      placeholderSvgDataUrl(product),
    ].filter(Boolean) as string[];
  }, [result, product]);

  const [imgIndex, setImgIndex] = useState(0);
  useEffect(() => setImgIndex(0), [fallbacks.length, product, result?.provider]);

  const posterSrc = fallbacks[imgIndex] || placeholderSvgDataUrl(product);
  const handleImgError = () =>
    setImgIndex((i) => Math.min(i + 1, fallbacks.length - 1));

  return (
    <main className="min-h-screen p-6 flex flex-col items-center bg-gray-50 text-gray-900">
      <div className="w-full max-w-3xl space-y-4">
        <h1 className="text-3xl font-bold">Brand-in-a-Box</h1>
        <p className="text-gray-900">Type your product, get copy + a poster.</p>

        <form onSubmit={handleGenerate} className="grid gap-3 bg-white p-4 rounded-xl shadow">
          <input
            className="border p-2 rounded text-gray-900 placeholder:text-gray-700"
            placeholder="Product (e.g., Pumpkin Spice Cold Brew)"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            required
          />
          <input
            className="border p-2 rounded text-gray-900 placeholder:text-gray-700"
            placeholder="Audience (optional)"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              className="border p-2 rounded text-gray-900 placeholder:text-gray-700"
              placeholder="Tone (friendly, playful, luxury…)"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
            />
            <input
              className="border p-2 rounded text-gray-900 placeholder:text-gray-700"
              placeholder="Platform (Instagram, LinkedIn…)"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="border p-2 rounded text-gray-900 placeholder:text-gray-700"
              placeholder="Image style (clean, retro, neon…)"
              value={imageStyle}
              onChange={(e) => setImageStyle(e.target.value)}
            />
            <input
              className="border p-2 rounded text-gray-900 placeholder:text-gray-700"
              placeholder="Color hint (#FF8800, teal…)"
              value={colorHint}
              onChange={(e) => setColorHint(e.target.value)}
            />
          </div>
          <button disabled={loading} className="bg-black text-white rounded p-2">
            {loading ? "Making magic…" : "Generate"}
          </button>
          {error && <p className="text-red-600">{error}</p>}
        </form>

        {result?.message && (
          <div className="bg-amber-100 border border-amber-300 text-amber-900 p-3 rounded">
            {result.message}
          </div>
        )}

        {result && (
          <section className="grid gap-4">
            <div className="bg-white p-4 rounded-xl shadow">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-xl text-gray-900">Copy</h2>
                {result.provider && (
                  <span className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700">
                    provider: {result.provider}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <strong>Tagline</strong>
                  <button className="text-sm underline" onClick={() => copyToClipboard(result.copy?.tagline || "")}>
                    Copy
                  </button>
                </div>
                <p>{result.copy?.tagline}</p>

                <div className="flex justify-between items-center">
                  <strong>Caption</strong>
                  <button className="text-sm underline" onClick={() => copyToClipboard(result.copy?.caption || "")}>
                    Copy
                  </button>
                </div>
                <p>{result.copy?.caption}</p>

                <div className="flex justify-between items-center">
                  <strong>Short Description</strong>
                  <button
                    className="text-sm underline"
                    onClick={() => copyToClipboard(result.copy?.shortDescription || "")}
                  >
                    Copy
                  </button>
                </div>
                <p>{result.copy?.shortDescription}</p>

                <div className="flex justify-between items-center">
                  <strong>Hashtags</strong>
                  <button
                    className="text-sm underline"
                    onClick={() => copyToClipboard((result.copy?.hashtags || []).join(" "))}
                  >
                    Copy
                  </button>
                </div>
                <p>{(result.copy?.hashtags || []).join(" ")}</p>
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl shadow">
              <h2 className="font-semibold text-xl mb-2 text-gray-900">Poster Image</h2>
              <img
                src={posterSrc}
                alt="Generated poster"
                className="rounded-xl w-full max-h-[512px] object-contain"
                onError={handleImgError}
              />
              <a href={posterSrc} download="poster" className="underline mt-2 inline-block">
                Download image
              </a>
            </div>
          </section>
        )}

        <footer className="text-xs text-gray-500 pt-4">© {new Date().getFullYear()} Veronica Foltz </footer>
      </div>
    </main>
  );
}