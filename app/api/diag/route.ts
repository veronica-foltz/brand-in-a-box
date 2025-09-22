import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const hasGroq   = !!process.env.GROQ_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const pexelsSet = !!process.env.PEXELS_API_KEY;
  const providerEnv = process.env.AI_PROVIDER || "(unset)";
  const isVercel  = process.env.VERCEL === "1";

  let willUse: "openai"|"groq"|"ollama"|"demo" = "demo";
  if (hasOpenAI) willUse = "openai";
  else if (hasGroq) willUse = "groq";
  else if (!isVercel && providerEnv === "ollama") willUse = "ollama";
  else willUse = "demo";

  return NextResponse.json(
    { isVercel, providerEnv, hasGroq, hasOpenAI, pexelsSet, willUse, model: process.env.GROQ_MODEL || "mixtral-8x7b-32768" },
    { headers: { "Cache-Control": "no-store" } }
  );
}