import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import {
  advanceOwnedMockJob,
  getOwnedJob,
  updateOwnedJob,
  updateOwnedScene,
} from "../../../../lib/repository";
import { createVideoProvider } from "../../../../lib/veo-provider";
import { extractLastFrame } from "../../../../lib/renderer-client";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const current = await getOwnedJob(user.email, id);
  if (!current) return NextResponse.json({ error: "job_not_found" }, { status: 404 });

  if (current.provider === "mock") {
    return NextResponse.json({ job: await advanceOwnedMockJob(user.email, id) });
  }
  if (!current.providerOperationId || ["done", "failed", "canceled"].includes(current.status)) {
    return NextResponse.json({ job: current });
  }

  try {
    const operation = await createVideoProvider().poll(current.providerOperationId);
    let endFrameUri: string | null = null;
    if (operation.status === "done" && operation.outputVideoUri) {
      endFrameUri = await extractLastFrame(
        operation.outputVideoUri,
        current.projectId,
        current.sceneId,
        current.id,
      );
    }
    const continuityReady = operation.status === "done" && Boolean(endFrameUri);
    const job = await updateOwnedJob(user.email, id, {
      status: operation.status,
      progress: operation.progress,
      errorCode: operation.errorCode,
    });
    await updateOwnedScene(user.email, current.sceneId, {
      status: operation.status === "done" ? (continuityReady ? "approved" : "quality_check") : operation.status === "failed" ? "failed" : "generating",
      outputVideoUri: operation.outputVideoUri,
      endFrameUri,
      qualityScore: continuityReady ? 90 : null,
    });
    return NextResponse.json({ job, continuityReady });
  } catch (error) {
    return NextResponse.json(
      { error: "provider_poll_failed", message: error instanceof Error ? error.message : "Veo polling failed" },
      { status: 502 },
    );
  }
}
