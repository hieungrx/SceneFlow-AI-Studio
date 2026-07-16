import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import {
  getOwnedJob,
  getOwnedJobProcessingState,
  getOwnedScene,
  transitionOwnedJobFromSnapshot,
  transitionOwnedSceneFromStatus,
  transitionOwnedSceneFromStatusForJobClaim,
} from "../../../../lib/repository";
import { createVideoProvider } from "../../../../lib/veo-provider";
import { extractLastFrame, findExistingLastFrame } from "../../../../lib/renderer-client";
import {
  mockEndFrameUri,
  mockProviderPoll,
  pollGenerationJob,
  toPublicGenerationJob,
} from "../../../../lib/job-polling";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const current = await getOwnedJob(user.email, id);
  if (!current) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  const scene = await getOwnedScene(user.email, current.sceneId);
  if (!scene) return NextResponse.json({ error: "scene_not_found" }, { status: 404 });

  try {
    const result = await pollGenerationJob(id, {
      getJob: (jobId) => getOwnedJobProcessingState(user.email, jobId),
      getScene: (sceneId) => getOwnedScene(user.email, sceneId),
      transitionJob: (jobId, expected, patch) =>
        transitionOwnedJobFromSnapshot(user.email, jobId, expected, patch),
      transitionScene: (sceneId, expectedStatus, patch) =>
        transitionOwnedSceneFromStatus(user.email, sceneId, expectedStatus, patch),
      transitionSceneForClaim: (
        sceneId,
        expectedStatus,
        jobId,
        expectedClaimToken,
        expectedClaimKind,
        patch,
      ) => transitionOwnedSceneFromStatusForJobClaim(
        user.email,
        sceneId,
        expectedStatus,
        jobId,
        expectedClaimToken,
        expectedClaimKind,
        patch,
      ),
      pollProvider: (job) => job.provider === "mock"
        ? Promise.resolve(mockProviderPoll(job))
        : createVideoProvider().poll(job.providerOperationId as string),
      findExistingEndFrame: (job, outputVideoUri) => job.provider === "mock"
        ? Promise.resolve({ status: "missing" as const })
        : findExistingLastFrame(
            outputVideoUri,
            job.projectId,
            job.sceneId,
            job.id,
          ),
      extractEndFrame: (job, outputVideoUri) => job.provider === "mock"
        ? Promise.resolve({ status: "completed" as const, endFrameUri: mockEndFrameUri(job) })
        : extractLastFrame(
            outputVideoUri,
            job.projectId,
            job.sceneId,
            job.id,
          ),
    });
    if (!result) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
    const publicJob = toPublicGenerationJob(result.job);
    if (
      ["done", "failed", "canceled"].includes(result.job.status) &&
      ["queued", "generating"].includes(result.scene.status)
    ) {
      return NextResponse.json(
        { error: "job_scene_reconciliation_pending", job: publicJob },
        { status: 409 },
      );
    }
    return NextResponse.json({
      job: publicJob,
      continuityReady: Boolean(result.scene.outputVideoUri && result.scene.endFrameUri),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "provider_poll_failed", message: error instanceof Error ? error.message : "Veo polling failed" },
      { status: 502 },
    );
  }
}
