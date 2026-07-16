import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  findOwnedActiveJobForProject,
  getOwnedProject,
  listOwnedScenes,
  reserveOwnedFinalRender,
  updateOwnedRender,
} from "../../../../../lib/repository";
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
  const activeGeneration = await findOwnedActiveJobForProject(user.email, project.id);
  if (activeGeneration) {
    return NextResponse.json(
      { error: "generation_in_progress", jobId: activeGeneration.id },
      { status: 409 },
    );
  }
  const scenes = await listOwnedScenes(user.email, id);
  if (
    scenes.length === 0 ||
    scenes.some((scene) => scene.status !== "approved" || !scene.outputVideoUri)
  ) {
    return NextResponse.json(
      { error: "scenes_not_ready", message: "Mọi cảnh phải được duyệt trước khi ghép." },
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
  const reservation = await reserveOwnedFinalRender(user.email, render);
  if (reservation.kind === "blocked") {
    const error = reservation.error === "generation_in_progress"
      ? "generation_in_progress"
      : reservation.error === "project_not_found"
        ? "project_not_found"
        : "scenes_not_ready";
    return NextResponse.json(
      { error },
      { status: reservation.error === "project_not_found" ? 404 : 409 },
    );
  }
  if (reservation.kind === "reused") {
    return NextResponse.json(
      {
        render: {
          ...reservation.render,
          renderer: "ffmpeg-cloud-run",
          mediaUrl: reservation.render.status === "done"
            ? `/api/renders/${reservation.render.id}/media`
            : null,
        },
        reused: true,
      },
      { status: 202 },
    );
  }
  const reservedRender = reservation.render;
  const runningRender =
    (await updateOwnedRender(user.email, reservedRender.id, { status: "running" })) ??
    reservedRender;
  try {
    const dispatch = await dispatchFinalRender({ renderId: render.id, projectId: project.id, manifest });
    const isMockRender = !dispatch && manifest.scenes.every((scene) => scene.sourceUri.startsWith("mock://"));
    const completedRender: FinalRender | null = dispatch
      ? {
          ...runningRender,
          status: "done",
          outputVideoUri: dispatch.outputUri,
          durationSeconds: dispatch.durationSeconds ?? manifest.calculatedDurationSeconds,
          updatedAt: new Date().toISOString(),
        }
      : isMockRender
        ? {
            ...runningRender,
            status: "done",
            outputVideoUri: "/mock/sceneflow-preview.mp4",
            durationSeconds: manifest.calculatedDurationSeconds,
            updatedAt: new Date().toISOString(),
          }
        : null;
    if (!completedRender) {
      const failedRender =
        (await updateOwnedRender(user.email, render.id, { status: "failed" })) ?? {
          ...runningRender,
          status: "failed" as const,
        };
      return NextResponse.json(
        { error: "renderer_not_configured", render: failedRender },
        { status: 503 },
      );
    }
    const savedRender = completedRender
      ? (await updateOwnedRender(user.email, render.id, completedRender)) ?? completedRender
      : runningRender;
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
  } catch {
    const failedRender =
      (await updateOwnedRender(user.email, render.id, { status: "failed" })) ?? {
        ...runningRender,
        status: "failed" as const,
      };
    return NextResponse.json(
      { error: "renderer_dispatch_failed", render: failedRender },
      { status: 502 },
    );
  }
}
