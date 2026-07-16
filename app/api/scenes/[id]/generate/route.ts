import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  activateOwnedGeneration,
  failOwnedGenerationSubmissionAndRefund,
  getOwnedJobProcessingState,
  getOwnedProject,
  getOwnedScene,
  reserveOwnedGeneration,
  transitionOwnedJobFromSnapshot,
} from "../../../../../lib/repository";
import { startGeneration } from "../../../../../lib/generation-start";
import { toPublicGenerationJob } from "../../../../../lib/job-polling";
import { createVideoProvider } from "../../../../../lib/veo-provider";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const result = await startGeneration(user.email, id, createVideoProvider(), {
    getScene: getOwnedScene,
    getProject: getOwnedProject,
    getJob: getOwnedJobProcessingState,
    reserve: reserveOwnedGeneration,
    transitionJob: transitionOwnedJobFromSnapshot,
    activate: activateOwnedGeneration,
    failAndRefund: failOwnedGenerationSubmissionAndRefund,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.job ? { job: toPublicGenerationJob(result.job) } : {}),
        ...(result.requiredCredits !== undefined
          ? { requiredCredits: result.requiredCredits }
          : {}),
        ...(result.balance !== undefined ? { balance: result.balance } : {}),
        ...(result.refundedCredits !== undefined
          ? { credits: { refunded: result.refundedCredits, balanceAfter: result.balanceAfter } }
          : {}),
      },
      { status: result.status },
    );
  }

  return NextResponse.json(
    {
      job: toPublicGenerationJob(result.job),
      reused: result.reused,
      ...(result.chargedCredits !== undefined
        ? { credits: { charged: result.chargedCredits, balanceAfter: result.balanceAfter } }
        : {}),
    },
    { status: 202 },
  );
}
