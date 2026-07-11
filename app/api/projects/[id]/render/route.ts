import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { createOwnedRender, getOwnedProject, listOwnedScenes, updateOwnedRender } from "../../../../../lib/repository";
import { buildRenderManifest } from "../../../../../lib/render-plan";
import type { FinalRender } from "../../../../../lib/types";
import { dispatchFinalRender } from "../../../../../lib/renderer-client";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const scenes = await listOwnedScenes(user.email, id);
  if (scenes.length === 0 || scenes.some((scene) => !scene.outputVideoUri)) {
    return NextResponse.json(
      { error: "scenes_not_ready", message: "Mọi cảnh phải hoàn tất trước khi ghép." },
      { status: 409 },
    );
  }

  const manifest = buildRenderManifest(id, scenes, project.targetDurationSeconds);
  const now = new Date().toISOString();
  const render: FinalRender = {
    id: `render_${crypto.randomUUID()}`,
    projectId: project.id,
    status: "queued",
    manifest,
    outputVideoUri: null,
    durationSeconds: null,
    createdAt: now,
    updatedAt: now,
  };
  await createOwnedRender(user.email, render);
  const dispatch = await dispatchFinalRender({ renderId: render.id, projectId: project.id, manifest });
  const isMockRender = !dispatch && manifest.scenes.every((scene) => scene.sourceUri.startsWith("mock://"));
  const completedRender: FinalRender | null = dispatch
    ? {
        ...render,
        status: "done",
        outputVideoUri: dispatch.outputUri,
        durationSeconds: dispatch.durationSeconds ?? manifest.calculatedDurationSeconds,
        updatedAt: new Date().toISOString(),
      }
    : isMockRender
      ? {
          ...render,
          status: "done",
          outputVideoUri: "/mock/sceneflow-preview.mp4",
          durationSeconds: manifest.calculatedDurationSeconds,
          updatedAt: new Date().toISOString(),
        }
    : null;
  const savedRender = completedRender
    ? (await updateOwnedRender(user.email, render.id, completedRender)) ?? completedRender
    : render;
  return NextResponse.json(
    {
      render: {
        ...savedRender,
        renderer: dispatch ? "ffmpeg-cloud-run" : isMockRender ? "mock-ffmpeg" : "not_configured",
        mediaUrl: savedRender.status === "done" ? `/api/renders/${savedRender.id}/media` : null,
      },
    },
    { status: 202 },
  );
}
