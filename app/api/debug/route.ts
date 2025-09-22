import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const { product = "test" } = await req.json().catch(() => ({}));
    const key = process.env.GROQ_API_KEY;
    if (!key) return NextResponse.json({ error: "No GROQ_API_KEY" }, { status: 500 });

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        temperature: 0.7,
        messages: [
          { role: "system", content: "Return ONLY a JSON object. No code fences." },
          { role: "user", content: `Give {"tagline":"...", "caption":"...", "shortDescription":"...", "hashtags":["#a","#b","#c","#d","#e"]} for product: ${product}` },
        ],
      }),
      cache: "no-store",
    });

    const json = await res.json();
    const raw = json?.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ ok: res.ok, raw, apiJson: json }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}