import { NextResponse } from "next/server";
import { compileBriefPreview } from "../../../../lib/prompt-compiler";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 3000) {
    return NextResponse.json({ error: "prompt_required" }, { status: 400 });
  }
  const result = compileBriefPreview({
    rawPrompt: body.prompt.trim(),
    aspectRatio: body.aspectRatio === "16:9" ? "16:9" : "9:16",
    durationSeconds: body.durationSeconds === 4 || body.durationSeconds === 6 ? body.durationSeconds : 8,
    model:
      body.model === "veo-3.1-fast" || body.model === "veo-3.1-standard"
        ? body.model
        : "veo-3.1-lite",
  });
  return NextResponse.json({ result });
}
