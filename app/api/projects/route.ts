import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../chatgpt-auth";
import { createOwnedProject, ensureUser, listOwnedProjects } from "../../../lib/repository";
import type { AspectRatio, VideoModel } from "../../../lib/types";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  return NextResponse.json({ projects: await listOwnedProjects(user.email) });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !isNonEmptyText(body.name, 120) || !isNonEmptyText(body.brief, 3000)) {
    return NextResponse.json({ error: "invalid_project_payload" }, { status: 400 });
  }

  await ensureUser(user.email, user.displayName);
  const project = await createOwnedProject(user.email, {
    name: body.name.trim(),
    brief: body.brief.trim(),
    template: typeof body.template === "string" ? body.template.slice(0, 80) : "KOC review sản phẩm",
    aspectRatio: (body.aspectRatio === "16:9" ? "16:9" : "9:16") as AspectRatio,
    targetDurationSeconds: clampDuration(body.targetDurationSeconds),
    model: normalizeModel(body.model),
  });
  return NextResponse.json({ project }, { status: 201 });
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function clampDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.max(8, Math.min(300, Math.round(value)));
}

function normalizeModel(value: unknown): VideoModel {
  if (value === "veo-3.1-fast" || value === "veo-3.1-standard") return value;
  return "veo-3.1-lite";
}
