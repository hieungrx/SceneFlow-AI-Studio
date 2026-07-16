import {
  END_FRAME_EXTRACTION_FAILED,
  endFrameExtractionFailure,
  generationSceneTransition,
  isActiveGenerationStatus,
} from "./scene-workflow.ts";
import type {
  GenerationJob,
  GenerationJobProcessingState,
  JobStatus,
  Scene,
} from "./types";
import type { ProviderOperation } from "./veo-provider";

type JobScenePair = {
  job: GenerationJobProcessingState;
  scene: Scene;
};

type JobSnapshot = Pick<GenerationJobProcessingState, "status" | "stateVersion">;

type PreferredJobOutcome = {
  status: "done" | "failed" | "canceled";
  progress: number;
  errorCode: string | null;
};

type ExtractionClaim = {
  token: string;
  kind: "completion" | "failure";
  expiresAt: string;
};

export type ExistingEndFrameResult =
  | { status: "ready"; endFrameUri: string; generation?: string }
  | { status: "missing" }
  | { status: "invalid"; errorCode: string };

export type EndFrameExtractionResult =
  | { status: "completed"; endFrameUri: string }
  | { status: "processing" }
  | { status: "failed"; errorCode: string };

export const EXTRACTION_CLAIM_PREFIX = "extraction_claim:";
const DEFAULT_EXTRACTION_LEASE_MS = 600_000;

export type JobPollingDependencies = {
  getJob: (jobId: string) => Promise<GenerationJobProcessingState | null>;
  getScene: (sceneId: string) => Promise<Scene | null>;
  transitionJob: (
    jobId: string,
    expected: JobSnapshot,
    patch: Partial<GenerationJobProcessingState>,
  ) => Promise<GenerationJobProcessingState | null>;
  transitionScene: (
    sceneId: string,
    expectedStatus: Scene["status"],
    patch: Partial<Scene>,
  ) => Promise<Scene | null>;
  transitionSceneForClaim: (
    sceneId: string,
    expectedStatus: Scene["status"],
    jobId: string,
    expectedClaimToken: string,
    expectedClaimKind: "completion" | "failure",
    patch: Partial<Scene>,
  ) => Promise<Scene | null>;
  pollProvider: (job: GenerationJobProcessingState) => Promise<ProviderOperation>;
  findExistingEndFrame: (
    job: GenerationJobProcessingState,
    outputVideoUri: string,
  ) => Promise<ExistingEndFrameResult>;
  extractEndFrame: (
    job: GenerationJobProcessingState,
    outputVideoUri: string,
  ) => Promise<EndFrameExtractionResult>;
  createClaimToken?: () => string;
  now?: () => number;
  extractionLeaseMs?: number;
};

export async function pollGenerationJob(
  jobId: string,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  let pair = await reconcileGenerationPair(jobId, dependencies);
  if (!pair || isConsistentTerminalPair(pair)) return pair;
  if (!isActiveGenerationStatus(pair.scene.status) || !pair.job.providerOperationId) return pair;

  const activeClaim = extractionClaim(pair.job);
  if (activeClaim) {
    return continueOrTakeOverClaim(jobId, pair, activeClaim, dependencies);
  }
  if (hasInternalExtractionState(pair.job)) return pair;

  if (
    pair.job.status === "failed" &&
    pair.job.errorCode === END_FRAME_EXTRACTION_FAILED &&
    !pair.scene.outputVideoUri
  ) {
    const recoveredClaim = await acquireLegacyFailureClaim(pair.job, dependencies);
    if (!recoveredClaim) return reconcileGenerationPair(jobId, dependencies);
    return processAcquiredClaim(jobId, recoveredClaim, null, dependencies);
  }

  const operation = await dependencies.pollProvider(pair.job);
  pair = (await reconcileGenerationPair(jobId, dependencies)) ?? pair;
  if (isConsistentTerminalPair(pair)) return pair;
  if (!isActiveGenerationStatus(pair.scene.status)) {
    return reconcileGenerationPair(jobId, dependencies);
  }

  const concurrentClaim = extractionClaim(pair.job);
  if (concurrentClaim) {
    return continueOrTakeOverClaim(jobId, pair, concurrentClaim, dependencies);
  }

  if (operation.status === "queued" || operation.status === "running") {
    if (isTerminalJobStatus(pair.job.status)) return pair;
    const scenePatch = generationSceneTransition(pair.scene, { kind: "running" });
    if (!scenePatch) return reconcileGenerationPair(jobId, dependencies);
    const transitionedScene = await dependencies.transitionScene(
      pair.scene.id,
      pair.scene.status,
      scenePatch,
    );
    if (!transitionedScene) return reconcileGenerationPair(jobId, dependencies);
    const transitionedJob = await dependencies.transitionJob(
      pair.job.id,
      jobSnapshot(pair.job),
      {
        status: operation.status,
        progress: operation.progress,
        errorCode: operation.errorCode,
      },
    );
    return transitionedJob
      ? readPair(jobId, dependencies)
      : reconcileGenerationPair(jobId, dependencies);
  }

  if (operation.status === "done" && operation.outputVideoUri) {
    const claimedJob = await acquireExtractionClaim(pair.job, dependencies, "completion");
    if (!claimedJob) return reconcileGenerationPair(jobId, dependencies);
    return processAcquiredClaim(jobId, claimedJob, operation, dependencies);
  }

  return failWithoutExtractionClaim(jobId, pair, operation, dependencies);
}

export function toPublicGenerationJob(job: GenerationJobProcessingState): GenerationJob {
  return {
    id: job.id,
    projectId: job.projectId,
    sceneId: job.sceneId,
    provider: job.provider,
    providerOperationId: job.providerOperationId,
    model: job.model,
    status: job.status,
    progress: job.progress,
    attempt: job.attempt,
    estimatedCostUsd: job.estimatedCostUsd,
    errorCode: job.errorCode?.startsWith(EXTRACTION_CLAIM_PREFIX) ? null : job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function mockProviderPoll(job: GenerationJobProcessingState): ProviderOperation {
  if (job.status === "done") {
    return {
      operationId: job.providerOperationId ?? `mock_${job.id}`,
      status: "done",
      progress: 100,
      outputVideoUri: mockOutputVideoUri(job),
      errorCode: null,
    };
  }
  const progress = job.status === "queued" ? 28 : Math.min(100, job.progress + 36);
  return {
    operationId: job.providerOperationId ?? `mock_${job.id}`,
    status: progress >= 100 ? "done" : "running",
    progress,
    outputVideoUri: progress >= 100 ? mockOutputVideoUri(job) : null,
    errorCode: null,
  };
}

export function mockEndFrameUri(job: GenerationJobProcessingState): string {
  return `mock://frames/${job.projectId}/${job.sceneId}-last.jpg`;
}

async function continueOrTakeOverClaim(
  jobId: string,
  pair: JobScenePair,
  claim: ExtractionClaim,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  if (!isExtractionLeaseExpired(claim, dependencies)) return pair;
  const claimedJob = await acquireExtractionClaim(pair.job, dependencies, claim.kind);
  if (!claimedJob) return reconcileGenerationPair(jobId, dependencies);
  const nextClaim = extractionClaim(claimedJob);
  if (!nextClaim || nextClaim.token === claim.token) {
    return reconcileGenerationPair(jobId, dependencies);
  }
  return processAcquiredClaim(jobId, claimedJob, null, dependencies);
}

async function acquireExtractionClaim(
  job: GenerationJobProcessingState,
  dependencies: JobPollingDependencies,
  kind: "completion" | "failure",
): Promise<GenerationJobProcessingState | null> {
  const token = dependencies.createClaimToken?.() ?? crypto.randomUUID();
  const now = dependencies.now?.() ?? Date.now();
  return dependencies.transitionJob(job.id, jobSnapshot(job), {
    extractionClaimToken: token,
    extractionClaimKind: kind,
    extractionClaimExpiresAt: new Date(
      now + (dependencies.extractionLeaseMs ?? DEFAULT_EXTRACTION_LEASE_MS),
    ).toISOString(),
    extractionFailureCode:
      kind === "failure" ? job.extractionFailureCode : null,
  });
}

async function acquireLegacyFailureClaim(
  job: GenerationJobProcessingState,
  dependencies: JobPollingDependencies,
): Promise<GenerationJobProcessingState | null> {
  const token = dependencies.createClaimToken?.() ?? crypto.randomUUID();
  const now = dependencies.now?.() ?? Date.now();
  return dependencies.transitionJob(job.id, jobSnapshot(job), {
    status: "running",
    errorCode: null,
    extractionClaimToken: token,
    extractionClaimKind: "failure",
    extractionClaimExpiresAt: new Date(
      now + (dependencies.extractionLeaseMs ?? DEFAULT_EXTRACTION_LEASE_MS),
    ).toISOString(),
    extractionFailureCode: END_FRAME_EXTRACTION_FAILED,
  });
}

async function processAcquiredClaim(
  jobId: string,
  claimedJob: GenerationJobProcessingState,
  knownOperation: ProviderOperation | null,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const claim = extractionClaim(claimedJob);
  if (!claim) return reconcileGenerationPair(jobId, dependencies);
  let pair = await readPair(jobId, dependencies);
  if (!pair || !isCurrentClaim(pair, claim) || !isActiveGenerationStatus(pair.scene.status)) {
    return reconcileGenerationPair(jobId, dependencies);
  }

  let outputVideoUri = pair.scene.outputVideoUri;
  let operation = knownOperation;
  if (!outputVideoUri) {
    operation ??= await dependencies.pollProvider(pair.job);
    if (
      claim.kind === "completion" &&
      (operation.status === "queued" || operation.status === "running")
    ) {
      const released = await dependencies.transitionJob(
        pair.job.id,
        jobSnapshot(pair.job),
        {
          status: operation.status,
          progress: operation.progress,
          errorCode: operation.errorCode,
          extractionClaimToken: null,
          extractionClaimKind: null,
          extractionClaimExpiresAt: null,
          extractionFailureCode: null,
        },
      );
      return released
        ? readPair(jobId, dependencies)
        : reconcileGenerationPair(jobId, dependencies);
    }
    if (operation.status === "queued" || operation.status === "running") return pair;
    if (operation.status !== "done" || !operation.outputVideoUri) {
      return failClaimedProviderOperation(jobId, pair, claim, operation, dependencies);
    }
    outputVideoUri = operation.outputVideoUri;
    const captured = await captureProviderOutput(pair, claim, outputVideoUri, dependencies);
    if (!captured) return reconcileGenerationPair(jobId, dependencies);
    pair = captured;
  }

  if (claim.kind === "failure") {
    return completeExtractionFailure(jobId, pair, claim, dependencies);
  }

  return processClaimedOutput(jobId, pair, claim, outputVideoUri, dependencies);
}

async function captureProviderOutput(
  pair: JobScenePair,
  claim: ExtractionClaim,
  outputVideoUri: string,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  if (pair.scene.outputVideoUri === outputVideoUri) return pair;
  if (pair.scene.outputVideoUri && pair.scene.outputVideoUri !== outputVideoUri) return null;
  const scene = await dependencies.transitionSceneForClaim(
    pair.scene.id,
    pair.scene.status,
    pair.job.id,
    claim.token,
    claim.kind,
    { outputVideoUri, endFrameUri: null },
  );
  return scene ? { job: pair.job, scene } : null;
}

async function processClaimedOutput(
  jobId: string,
  claimedPair: JobScenePair,
  claim: ExtractionClaim,
  outputVideoUri: string,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const existing = await dependencies.findExistingEndFrame(claimedPair.job, outputVideoUri);
  if (existing.status === "invalid") {
    return persistAndCompleteExtractionFailure(jobId, claimedPair, claim, dependencies);
  }
  if (existing.status === "ready") {
    return completeClaimedSuccess(
      jobId,
      claimedPair,
      claim,
      outputVideoUri,
      existing.endFrameUri,
      dependencies,
    );
  }

  const currentPair = await readPair(jobId, dependencies);
  if (!currentPair || !isCurrentClaim(currentPair, claim)) return currentPair;
  const renewedJob = await renewExtractionClaim(currentPair.job, claim, dependencies);
  if (!renewedJob) return reconcileGenerationPair(jobId, dependencies);
  const renewedPair = { job: renewedJob, scene: currentPair.scene };
  const extraction = await dependencies.extractEndFrame(renewedJob, outputVideoUri);
  if (extraction.status === "processing") return readPair(jobId, dependencies);
  if (extraction.status === "failed") {
    return persistAndCompleteExtractionFailure(jobId, renewedPair, claim, dependencies);
  }

  if (renewedJob.provider !== "mock") {
    const validated = await dependencies.findExistingEndFrame(renewedJob, outputVideoUri);
    if (validated.status !== "ready") {
      return persistAndCompleteExtractionFailure(jobId, renewedPair, claim, dependencies);
    }
    return completeClaimedSuccess(
      jobId,
      renewedPair,
      claim,
      outputVideoUri,
      validated.endFrameUri,
      dependencies,
    );
  }

  return completeClaimedSuccess(
    jobId,
    renewedPair,
    claim,
    outputVideoUri,
    extraction.endFrameUri,
    dependencies,
  );
}

async function renewExtractionClaim(
  job: GenerationJobProcessingState,
  claim: ExtractionClaim,
  dependencies: JobPollingDependencies,
): Promise<GenerationJobProcessingState | null> {
  if (!isClaimOnJob(job, claim)) return null;
  const now = dependencies.now?.() ?? Date.now();
  return dependencies.transitionJob(job.id, jobSnapshot(job), {
    extractionClaimExpiresAt: new Date(
      now + (dependencies.extractionLeaseMs ?? DEFAULT_EXTRACTION_LEASE_MS),
    ).toISOString(),
  });
}

async function persistAndCompleteExtractionFailure(
  jobId: string,
  pair: JobScenePair,
  claim: ExtractionClaim,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const current = await readPair(jobId, dependencies);
  if (!current || !isCurrentClaim(current, claim)) return current;
  const now = dependencies.now?.() ?? Date.now();
  const failureJob = await dependencies.transitionJob(
    current.job.id,
    jobSnapshot(current.job),
    {
      extractionClaimKind: "failure",
      extractionClaimExpiresAt: new Date(
        now + (dependencies.extractionLeaseMs ?? DEFAULT_EXTRACTION_LEASE_MS),
      ).toISOString(),
      extractionFailureCode: END_FRAME_EXTRACTION_FAILED,
    },
  );
  if (!failureJob) return reconcileGenerationPair(jobId, dependencies);
  const failureClaim = extractionClaim(failureJob);
  if (!failureClaim) return reconcileGenerationPair(jobId, dependencies);
  return completeExtractionFailure(
    jobId,
    { job: failureJob, scene: current.scene },
    failureClaim,
    dependencies,
  );
}

async function completeExtractionFailure(
  jobId: string,
  pair: JobScenePair,
  claim: ExtractionClaim,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  if (
    claim.kind !== "failure" ||
    pair.job.extractionFailureCode !== END_FRAME_EXTRACTION_FAILED
  ) {
    return reconcileGenerationPair(jobId, dependencies);
  }
  if (!isActiveGenerationStatus(pair.scene.status)) {
    return reconcileGenerationPair(jobId, dependencies, {
      status: "failed",
      progress: pair.job.progress,
      errorCode: END_FRAME_EXTRACTION_FAILED,
    });
  }
  if (!pair.scene.outputVideoUri) return pair;
  const failure = endFrameExtractionFailure(pair.scene, pair.scene.outputVideoUri);
  if (!failure.scenePatch) return reconcileGenerationPair(jobId, dependencies);
  const scene = await dependencies.transitionSceneForClaim(
    pair.scene.id,
    pair.scene.status,
    pair.job.id,
    claim.token,
    "failure",
    failure.scenePatch,
  );
  if (!scene) return reconcileGenerationPair(jobId, dependencies);
  return reconcileGenerationPair(jobId, dependencies, {
    status: "failed",
    progress: pair.job.progress,
    errorCode: failure.errorCode,
  });
}

async function completeClaimedSuccess(
  jobId: string,
  pair: JobScenePair,
  claim: ExtractionClaim,
  outputVideoUri: string,
  endFrameUri: string,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const current = await readPair(jobId, dependencies);
  if (!current || !isCurrentClaim(current, claim)) return current;
  const scenePatch = generationSceneTransition(current.scene, {
    kind: "completed",
    outputVideoUri,
    endFrameUri,
  });
  if (!scenePatch) return reconcileGenerationPair(jobId, dependencies);
  const scene = await dependencies.transitionSceneForClaim(
    current.scene.id,
    current.scene.status,
    current.job.id,
    claim.token,
    "completion",
    { ...scenePatch, qualityScore: current.job.provider === "mock" ? 94 : 90 },
  );
  if (!scene) return reconcileGenerationPair(jobId, dependencies);
  return reconcileGenerationPair(jobId, dependencies, {
    status: "done",
    progress: 100,
    errorCode: null,
  });
}

async function failClaimedProviderOperation(
  jobId: string,
  pair: JobScenePair,
  claim: ExtractionClaim,
  operation: ProviderOperation,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const status = operation.status === "canceled" ? "canceled" : "failed";
  const errorCode = operation.status === "done"
    ? operation.errorCode ?? "no_video_returned"
    : operation.errorCode;
  const scenePatch = generationSceneTransition(pair.scene, {
    kind: "failed",
    outputVideoUri: operation.outputVideoUri,
  });
  if (!scenePatch) return reconcileGenerationPair(jobId, dependencies);
  const scene = await dependencies.transitionSceneForClaim(
    pair.scene.id,
    pair.scene.status,
    pair.job.id,
    claim.token,
    claim.kind,
    scenePatch,
  );
  if (!scene) return reconcileGenerationPair(jobId, dependencies);
  return reconcileGenerationPair(jobId, dependencies, {
    status,
    progress: operation.progress,
    errorCode,
  });
}

async function failWithoutExtractionClaim(
  jobId: string,
  pair: JobScenePair,
  operation: ProviderOperation,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const status = operation.status === "canceled" ? "canceled" : "failed";
  const errorCode = operation.status === "done"
    ? operation.errorCode ?? "no_video_returned"
    : operation.errorCode;
  const scenePatch = generationSceneTransition(pair.scene, {
    kind: "failed",
    outputVideoUri: operation.outputVideoUri,
  });
  if (!scenePatch) return reconcileGenerationPair(jobId, dependencies);
  await dependencies.transitionScene(pair.scene.id, pair.scene.status, scenePatch);
  return reconcileGenerationPair(jobId, dependencies, {
    status,
    progress: operation.progress,
    errorCode,
  });
}

async function reconcileGenerationPair(
  jobId: string,
  dependencies: JobPollingDependencies,
  preferred?: PreferredJobOutcome,
): Promise<JobScenePair | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pair = await readPair(jobId, dependencies);
    if (!pair) return null;
    const desired = desiredJobOutcome(pair, preferred);
    if (desired) {
      if (jobMatchesOutcome(pair.job, desired)) return pair;
      const job = await dependencies.transitionJob(pair.job.id, jobSnapshot(pair.job), {
        ...desired,
        extractionClaimToken: null,
        extractionClaimKind: null,
        extractionClaimExpiresAt: null,
        extractionFailureCode: null,
      });
      if (job) return { job, scene: pair.scene };
      continue;
    }

    if (
      isActiveGenerationStatus(pair.scene.status) &&
      !extractionClaim(pair.job) &&
      (pair.job.status === "failed" || pair.job.status === "canceled")
    ) {
      if (
        pair.job.status === "failed" &&
        pair.job.errorCode === END_FRAME_EXTRACTION_FAILED &&
        !pair.scene.outputVideoUri
      ) {
        return pair;
      }
      const scenePatch = generationSceneTransition(pair.scene, {
        kind: "failed",
        outputVideoUri: pair.scene.outputVideoUri,
      });
      if (!scenePatch) return pair;
      await dependencies.transitionScene(pair.scene.id, pair.scene.status, scenePatch);
      continue;
    }

    if (
      isActiveGenerationStatus(pair.scene.status) &&
      pair.job.status === "done" &&
      !extractionClaim(pair.job)
    ) {
      const repaired = await dependencies.transitionJob(pair.job.id, jobSnapshot(pair.job), {
        status: "running",
        progress: Math.min(pair.job.progress, 99),
        errorCode: null,
      });
      if (repaired) continue;
      continue;
    }
    return pair;
  }
  return readPair(jobId, dependencies);
}

function desiredJobOutcome(
  pair: JobScenePair,
  preferred?: PreferredJobOutcome,
): PreferredJobOutcome | null {
  if (["quality_check", "approved", "rejected"].includes(pair.scene.status)) {
    return { status: "done", progress: 100, errorCode: null };
  }
  if (pair.scene.status !== "failed") return null;
  const status = preferred?.status === "canceled" || pair.job.status === "canceled"
    ? "canceled"
    : "failed";
  return {
    status,
    progress: Math.max(pair.job.progress, preferred?.progress ?? pair.job.progress),
    errorCode:
      preferred?.errorCode ??
      pair.job.extractionFailureCode ??
      sanitizedErrorCode(pair.job.errorCode) ??
      (pair.scene.outputVideoUri && !pair.scene.endFrameUri
        ? END_FRAME_EXTRACTION_FAILED
        : "generation_failed"),
  };
}

function extractionClaim(job: GenerationJobProcessingState): ExtractionClaim | null {
  if (
    !job.extractionClaimToken ||
    !job.extractionClaimKind ||
    !job.extractionClaimExpiresAt
  ) {
    return null;
  }
  return {
    token: job.extractionClaimToken,
    kind: job.extractionClaimKind,
    expiresAt: job.extractionClaimExpiresAt,
  };
}

function hasInternalExtractionState(job: GenerationJobProcessingState): boolean {
  return Boolean(
    job.extractionClaimToken ||
    job.extractionClaimKind ||
    job.extractionClaimExpiresAt ||
    job.extractionFailureCode,
  );
}

function isExtractionLeaseExpired(
  claim: ExtractionClaim,
  dependencies: JobPollingDependencies,
): boolean {
  const expiresAt = Date.parse(claim.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return (dependencies.now?.() ?? Date.now()) >= expiresAt;
}

function jobSnapshot(job: GenerationJobProcessingState): JobSnapshot {
  return { status: job.status, stateVersion: job.stateVersion };
}

function jobMatchesOutcome(
  job: GenerationJobProcessingState,
  desired: PreferredJobOutcome,
): boolean {
  return job.status === desired.status &&
    job.progress === desired.progress &&
    job.errorCode === desired.errorCode &&
    !hasInternalExtractionState(job);
}

function isConsistentTerminalPair(pair: JobScenePair): boolean {
  if (["quality_check", "approved", "rejected"].includes(pair.scene.status)) {
    return pair.job.status === "done" && !hasInternalExtractionState(pair.job);
  }
  if (pair.scene.status === "failed") {
    return (pair.job.status === "failed" || pair.job.status === "canceled") &&
      !hasInternalExtractionState(pair.job);
  }
  return false;
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "canceled";
}

function isCurrentClaim(pair: JobScenePair, expected: ExtractionClaim): boolean {
  return isClaimOnJob(pair.job, expected) && isActiveGenerationStatus(pair.scene.status);
}

function isClaimOnJob(
  job: GenerationJobProcessingState,
  expected: ExtractionClaim,
): boolean {
  return job.extractionClaimToken === expected.token &&
    job.extractionClaimKind === expected.kind;
}

function sanitizedErrorCode(errorCode: string | null): string | null {
  return errorCode?.startsWith(EXTRACTION_CLAIM_PREFIX) ? null : errorCode;
}

async function readPair(
  jobId: string,
  dependencies: JobPollingDependencies,
): Promise<JobScenePair | null> {
  const job = await dependencies.getJob(jobId);
  if (!job) return null;
  const scene = await dependencies.getScene(job.sceneId);
  return scene ? { job, scene } : null;
}

function mockOutputVideoUri(job: GenerationJobProcessingState): string {
  return `mock://renders/${job.projectId}/${job.sceneId}.mp4`;
}
