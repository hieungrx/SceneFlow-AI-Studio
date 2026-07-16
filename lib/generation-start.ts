import type {
  GenerationJobProcessingState,
  Project,
  Scene,
} from "./types";
import { ProviderSubmissionError } from "./provider-submission.ts";
import type { ProviderOperation, VideoProvider } from "./veo-provider";

export type GenerationAdmissionError =
  | "scene_not_found"
  | "project_not_found"
  | "project_generation_in_progress"
  | "project_render_in_progress"
  | "scene_requires_qc_decision"
  | "previous_scene_not_approved"
  | "invalid_scene_generation_status"
  | "scene_generation_inconsistent"
  | "insufficient_credits";

export type GenerationReservationInput = {
  jobId: string;
  projectId: string;
  sceneId: string;
  provider: GenerationJobProcessingState["provider"];
  estimatedCostUsd: number;
  requiredCredits: number;
  createdAt: string;
};

export type GenerationReservationResult =
  | {
      kind: "reserved";
      job: GenerationJobProcessingState;
      project: Project;
      scene: Scene;
      balanceAfter: number;
    }
  | {
      kind: "reused";
      job: GenerationJobProcessingState;
      project: Project;
      scene: Scene;
    }
  | {
      kind: "blocked";
      error: GenerationAdmissionError;
      job?: GenerationJobProcessingState;
      requiredCredits?: number;
      balance?: number;
    };

export type GenerationActivationInput = {
  jobId: string;
  expectedStateVersion: number;
  expectedSceneStatus: Scene["status"];
  operation: ProviderOperation;
};

export type GenerationFailureInput = {
  jobId: string;
  expectedStateVersion: number;
  requiredCredits: number;
  errorCode: "provider_submission_rejected";
};

type JobSnapshot = Pick<GenerationJobProcessingState, "status" | "stateVersion">;

export type GenerationStartDependencies = {
  getScene: (ownerId: string, sceneId: string) => Promise<Scene | null>;
  getProject: (ownerId: string, projectId: string) => Promise<Project | null>;
  getJob: (ownerId: string, jobId: string) => Promise<GenerationJobProcessingState | null>;
  reserve: (
    ownerId: string,
    input: GenerationReservationInput,
  ) => Promise<GenerationReservationResult>;
  transitionJob: (
    ownerId: string,
    jobId: string,
    expected: JobSnapshot,
    patch: Partial<GenerationJobProcessingState>,
  ) => Promise<GenerationJobProcessingState | null>;
  activate: (
    ownerId: string,
    input: GenerationActivationInput,
  ) => Promise<GenerationJobProcessingState | null>;
  failAndRefund: (
    ownerId: string,
    input: GenerationFailureInput,
  ) => Promise<{ job: GenerationJobProcessingState; balanceAfter: number } | null>;
  now?: () => number;
  createJobId?: () => string;
};

export type GenerationStartResult =
  | {
      ok: true;
      job: GenerationJobProcessingState;
      reused: boolean;
      chargedCredits?: number;
      balanceAfter?: number;
    }
  | {
      ok: false;
      status: 404 | 409 | 402 | 502 | 503;
      error: GenerationAdmissionError | "provider_submission_failed" | "provider_submission_uncertain";
      job?: GenerationJobProcessingState;
      requiredCredits?: number;
      balance?: number;
      refundedCredits?: number;
      balanceAfter?: number;
    };

const SUBMISSION_UNCERTAIN_AFTER_MS = 120_000;

export async function startGeneration(
  ownerId: string,
  sceneId: string,
  provider: VideoProvider,
  dependencies: GenerationStartDependencies,
): Promise<GenerationStartResult> {
  const scene = await dependencies.getScene(ownerId, sceneId);
  if (!scene) return admissionError("scene_not_found");
  const project = await dependencies.getProject(ownerId, scene.projectId);
  if (!project) return admissionError("project_not_found");

  const estimatedCostUsd = estimateGenerationCost(project.model, 8);
  const requiredCredits = Math.max(1, Math.ceil(estimatedCostUsd * 10));
  const createdAt = new Date(dependencies.now?.() ?? Date.now()).toISOString();
  const reservation = await dependencies.reserve(ownerId, {
    jobId: dependencies.createJobId?.() ?? `job_${crypto.randomUUID()}`,
    projectId: project.id,
    sceneId,
    provider: provider.name,
    estimatedCostUsd,
    requiredCredits,
    createdAt,
  });

  if (reservation.kind === "blocked") {
    return {
      ...admissionError(reservation.error),
      ...(reservation.job ? { job: reservation.job } : {}),
      ...(reservation.requiredCredits !== undefined
        ? { requiredCredits: reservation.requiredCredits }
        : {}),
      ...(reservation.balance !== undefined ? { balance: reservation.balance } : {}),
    };
  }

  const { job, scene: authoritativeScene } = reservation;
  if (job.providerOperationId) {
    return { ok: true, job, reused: true };
  }
  if (!isAdmissionStatus(authoritativeScene.status)) {
    return {
      ok: false,
      status: 409,
      error: "scene_generation_inconsistent",
      job,
    };
  }
  if (job.status === "running") {
    if (isSubmissionUncertain(job, dependencies)) {
      return { ok: false, status: 503, error: "provider_submission_uncertain", job };
    }
    return { ok: true, job, reused: true };
  }
  if (job.status !== "queued") {
    return {
      ok: false,
      status: 409,
      error: "scene_generation_inconsistent",
      job,
    };
  }

  const claimed = await dependencies.transitionJob(
    ownerId,
    job.id,
    { status: "queued", stateVersion: job.stateVersion },
    { status: "running", progress: 0, errorCode: null },
  );
  if (!claimed) {
    const authoritative = await dependencies.getJob(ownerId, job.id);
    if (!authoritative) return admissionError("scene_generation_inconsistent");
    if (!authoritative.providerOperationId && isSubmissionUncertain(authoritative, dependencies)) {
      return {
        ok: false,
        status: 503,
        error: "provider_submission_uncertain",
        job: authoritative,
      };
    }
    return { ok: true, job: authoritative, reused: true };
  }

  let operation: ProviderOperation;
  try {
    operation = await provider.submit({
      projectId: reservation.project.id,
      sceneId: authoritativeScene.id,
      prompt: authoritativeScene.prompt,
      negativePrompt: authoritativeScene.negativePrompt,
      model: reservation.project.model,
      aspectRatio: reservation.project.aspectRatio,
      durationSeconds: 8,
      startFrameUri: authoritativeScene.startFrameUri,
      lastFrameUri: null,
    });
  } catch (error) {
    if (!(error instanceof ProviderSubmissionError) || error.ambiguous) {
      const uncertain = await dependencies.transitionJob(
        ownerId,
        claimed.id,
        { status: claimed.status, stateVersion: claimed.stateVersion },
        { errorCode: "provider_submission_uncertain" },
      );
      return {
        ok: false,
        status: 503,
        error: "provider_submission_uncertain",
        job: uncertain ?? claimed,
      };
    }
    const failed = await dependencies.failAndRefund(ownerId, {
      jobId: claimed.id,
      expectedStateVersion: claimed.stateVersion,
      requiredCredits,
      errorCode: "provider_submission_rejected",
    });
    if (!failed) {
      const authoritative = await dependencies.getJob(ownerId, claimed.id);
      return {
        ok: false,
        status: 503,
        error: "provider_submission_uncertain",
        job: authoritative ?? claimed,
      };
    }
    return {
      ok: false,
      status: 502,
      error: "provider_submission_failed",
      job: failed.job,
      refundedCredits: requiredCredits,
      balanceAfter: failed.balanceAfter,
    };
  }

  if (
    !operation.operationId ||
    (operation.status !== "queued" && operation.status !== "running")
  ) {
    const failed = await dependencies.failAndRefund(ownerId, {
      jobId: claimed.id,
      expectedStateVersion: claimed.stateVersion,
      requiredCredits,
      errorCode: "provider_submission_rejected",
    });
    if (!failed) {
      const authoritative = await dependencies.getJob(ownerId, claimed.id);
      return {
        ok: false,
        status: 503,
        error: "provider_submission_uncertain",
        job: authoritative ?? claimed,
      };
    }
    return {
      ok: false,
      status: 502,
      error: "provider_submission_failed",
      job: failed.job,
      refundedCredits: requiredCredits,
      balanceAfter: failed.balanceAfter,
    };
  }

  const activated = await dependencies.activate(ownerId, {
    jobId: claimed.id,
    expectedStateVersion: claimed.stateVersion,
    expectedSceneStatus: authoritativeScene.status,
    operation,
  });
  if (!activated) {
    const authoritative = await dependencies.getJob(ownerId, claimed.id);
    return {
      ok: false,
      status: 503,
      error: "provider_submission_uncertain",
      job: authoritative ?? claimed,
    };
  }

  return {
    ok: true,
    job: activated,
    reused: reservation.kind === "reused",
    ...(reservation.kind === "reserved"
      ? { chargedCredits: requiredCredits, balanceAfter: reservation.balanceAfter }
      : {}),
  };
}

export function isAdmissionStatus(status: Scene["status"]): boolean {
  return status === "planned" ||
    status === "waiting_previous" ||
    status === "approved" ||
    status === "rejected" ||
    status === "failed";
}

export function estimateGenerationCost(model: Project["model"], seconds: number): number {
  const rate = model === "veo-3.1-standard" ? 0.4 : model === "veo-3.1-fast" ? 0.1 : 0.05;
  return rate * seconds;
}

function isSubmissionUncertain(
  job: GenerationJobProcessingState,
  dependencies: GenerationStartDependencies,
): boolean {
  if (job.errorCode === "provider_submission_uncertain") return true;
  const updatedAt = Date.parse(job.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return (dependencies.now?.() ?? Date.now()) - updatedAt >= SUBMISSION_UNCERTAIN_AFTER_MS;
}

function admissionError(error: GenerationAdmissionError): Extract<GenerationStartResult, { ok: false }> {
  const status = error === "scene_not_found" || error === "project_not_found"
    ? 404
    : error === "insufficient_credits"
      ? 402
      : 409;
  return { ok: false, status, error };
}
