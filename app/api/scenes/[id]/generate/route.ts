import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  chargeCredits,
  createOwnedJob,
  findOwnedActiveJobForScene,
  getCreditBalance,
  getOwnedProject,
  getOwnedScene,
  invalidateOwnedDownstreamScenes,
  updateOwnedScene,
} from "../../../../../lib/repository";
import { createVideoProvider } from "../../../../../lib/veo-provider";
import type { GenerationJob } from "../../../../../lib/types";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const scene = await getOwnedScene(user.email, id);
  if (!scene) return NextResponse.json({ error: "scene_not_found" }, { status: 404 });
  const project = await getOwnedProject(user.email, scene.projectId);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const activeJob = await findOwnedActiveJobForScene(user.email, scene.id);
  if (activeJob) return NextResponse.json({ job: activeJob, reused: true }, { status: 202 });
  if (scene.status === "approved") {
    await invalidateOwnedDownstreamScenes(user.email, project.id, scene.sceneIndex);
  }

  if (scene.dependsOnSceneId) {
    const previous = await getOwnedScene(user.email, scene.dependsOnSceneId);
    if (!previous || previous.status !== "approved" || !previous.endFrameUri) {
      return NextResponse.json(
        { error: "previous_scene_not_approved", dependsOnSceneId: scene.dependsOnSceneId },
        { status: 409 },
      );
    }
    scene.startFrameUri = previous.endFrameUri;
  }

  const provider = createVideoProvider();
  const estimatedCostUsd = estimateCost(project.model, 8);
  const requiredCredits = Math.max(1, Math.ceil(estimatedCostUsd * 10));
  const balance = await getCreditBalance(user.email);
  if (balance < requiredCredits) {
    return NextResponse.json({ error: "insufficient_credits", requiredCredits, balance }, { status: 402 });
  }
  const operation = await provider.submit({
    projectId: project.id,
    sceneId: scene.id,
    prompt: scene.prompt,
    negativePrompt: scene.negativePrompt,
    model: project.model,
    aspectRatio: project.aspectRatio,
    durationSeconds: 8,
    startFrameUri: scene.startFrameUri,
    lastFrameUri: null,
  });
  const createdAt = new Date().toISOString();
  const job: GenerationJob = {
    id: `job_${crypto.randomUUID()}`,
    projectId: project.id,
    sceneId: scene.id,
    provider: provider.name,
    providerOperationId: operation.operationId,
    model: project.model,
    status: operation.status,
    progress: operation.progress,
    attempt: 1,
    estimatedCostUsd,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
  };
  await updateOwnedScene(user.email, scene.id, { status: "queued", startFrameUri: scene.startFrameUri });
  const saved = await createOwnedJob(user.email, job);
  if (!saved) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const balanceAfter = await chargeCredits({
    ownerId: user.email,
    projectId: project.id,
    jobId: job.id,
    amount: requiredCredits,
  });
  return NextResponse.json({ job: saved, credits: { charged: requiredCredits, balanceAfter } }, { status: 202 });
}

function estimateCost(model: string, seconds: number): number {
  const rate = model === "veo-3.1-standard" ? 0.4 : model === "veo-3.1-fast" ? 0.1 : 0.05;
  return rate * seconds;
}
