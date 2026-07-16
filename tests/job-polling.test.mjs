import assert from "node:assert/strict";
import test from "node:test";

import {
  pollGenerationJob,
  toPublicGenerationJob,
} from "../lib/job-polling.ts";

test("two concurrent completion polls produce one claim and one extraction", async () => {
  const extractorStarted = deferred();
  const releaseExtractor = deferred();
  const harness = makeHarness({
    extractEndFrame: async () => {
      extractorStarted.resolve();
      await releaseExtractor.promise;
      return { status: "completed", endFrameUri: "gs://media/end.jpg" };
    },
  });

  const winner = pollGenerationJob(harness.job.id, harness.dependencies);
  await extractorStarted.promise;
  const loser = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(loser.job.errorCode, null);
  assert.match(loser.job.extractionClaimToken, /^claim-/);
  assert.equal(loser.scene.status, "generating");
  assert.equal(harness.counts.claimWinners, 1);
  assert.equal(harness.counts.extractor, 1);
  assert.equal(harness.counts.rendererOperations, 1);

  releaseExtractor.resolve();
  const completed = await winner;
  assert.equal(completed.job.status, "done");
  assert.equal(completed.job.extractionClaimToken, null);
  assert.equal(completed.scene.status, "quality_check");
  assert.equal(completed.scene.outputVideoUri, "gs://media/output.mp4");
  assert.equal(completed.scene.endFrameUri, "gs://media/end.jpg");
  assert.equal(harness.counts.sceneTerminalTransitions, 1);
  assert.equal(harness.counts.jobTerminalTransitions, 1);
});

test("a valid extraction lease is read-only and skips provider and renderer", async () => {
  const harness = makeHarness({ claimToken: "active-owner" });

  const result = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(result.job.extractionClaimToken, "active-owner");
  assert.equal(result.job.errorCode, null);
  assert.equal(result.scene.status, "generating");
  assert.equal(harness.counts.claimWinners, 0);
  assert.equal(harness.counts.provider, 0);
  assert.equal(harness.counts.rendererRequests, 0);
});

test("an expired lease permits exactly one guarded takeover", async () => {
  const extractorStarted = deferred();
  const releaseExtractor = deferred();
  const harness = makeHarness({
    claimToken: "expired-owner",
    claimExpiresAtOffsetMs: -1,
    extractionLeaseMs: 100,
    outputVideoUri: "gs://media/output.mp4",
    extractEndFrame: async () => {
      extractorStarted.resolve();
      await releaseExtractor.promise;
      return { status: "completed", endFrameUri: "gs://media/takeover-end.jpg" };
    },
  });

  const takeover = pollGenerationJob(harness.job.id, harness.dependencies);
  await extractorStarted.promise;
  const competingPoll = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.notEqual(competingPoll.job.extractionClaimToken, "expired-owner");
  assert.equal(harness.counts.claimWinners, 1);
  assert.equal(harness.counts.extractor, 1);

  releaseExtractor.resolve();
  const completed = await takeover;
  assert.equal(completed.job.status, "done");
  assert.equal(completed.scene.endFrameUri, "gs://media/takeover-end.jpg");
});

test("a stale claimant cannot complete and renderer replay does not duplicate compute", async () => {
  const rendererStarted = deferred();
  const releaseRenderer = deferred();
  const harness = makeHarness({
    extractionLeaseMs: 100,
    dedupeRemoteOperation: true,
    onRendererStarted: () => rendererStarted.resolve(),
    releaseRenderer: releaseRenderer.promise,
  });

  const staleClaimant = pollGenerationJob(harness.job.id, harness.dependencies);
  await rendererStarted.promise;
  harness.advanceNow(101);
  const currentClaimant = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(currentClaimant.job.status, "running");
  assert.equal(harness.counts.rendererRequests, 2);
  assert.equal(harness.counts.rendererOperations, 1);
  assert.equal(harness.counts.extractor, 1);

  releaseRenderer.resolve();
  const staleResult = await staleClaimant;
  assert.equal(staleResult.job.status, "running");
  assert.equal(staleResult.scene.status, "generating");

  harness.advanceNow(101);
  const reconciled = await pollGenerationJob(harness.job.id, harness.dependencies);
  assert.equal(reconciled.job.status, "done");
  assert.equal(reconciled.scene.status, "quality_check");
  assert.equal(reconciled.scene.endFrameUri, "gs://media/end.jpg");
  assert.equal(harness.counts.rendererOperations, 1);
  assert.equal(harness.counts.sceneTerminalTransitions, 1);
});

test("a stale running provider result cannot overwrite a completed job", async () => {
  const providerStarted = deferred();
  const releaseProvider = deferred();
  const harness = makeHarness({
    pollProvider: async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return runningOperation();
    },
  });

  const poll = pollGenerationJob(harness.job.id, harness.dependencies);
  await providerStarted.promise;
  harness.forceCompleted();
  releaseProvider.resolve();
  const result = await poll;

  assert.equal(result.job.status, "done");
  assert.equal(result.scene.status, "quality_check");
  assert.equal(result.job.progress, 100);
});

test("a stale running provider result cannot overwrite a failed job", async () => {
  const providerStarted = deferred();
  const releaseProvider = deferred();
  const harness = makeHarness({
    pollProvider: async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return runningOperation();
    },
  });

  const poll = pollGenerationJob(harness.job.id, harness.dependencies);
  await providerStarted.promise;
  harness.forceFailed("provider_failed");
  releaseProvider.resolve();
  const result = await poll;

  assert.equal(result.job.status, "failed");
  assert.equal(result.job.errorCode, "provider_failed");
  assert.equal(result.scene.status, "failed");
});

test("an output created before claimant crash is reused without extraction", async () => {
  const harness = makeHarness({
    claimToken: "crashed-owner",
    claimExpiresAtOffsetMs: -1,
    outputVideoUri: "gs://media/output.mp4",
    artifactReady: true,
  });

  const result = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(result.job.status, "done");
  assert.equal(result.scene.status, "quality_check");
  assert.equal(result.scene.endFrameUri, "gs://media/end.jpg");
  assert.equal(harness.counts.outputChecks, 1);
  assert.equal(harness.counts.rendererRequests, 0);
});

test("scene CAS failure reloads authoritative completion instead of returning stale success", async () => {
  const harness = makeHarness({ failCompletionSceneCasWithAuthoritativeCompletion: true });

  const result = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(harness.counts.failedSceneCas, 1);
  assert.equal(result.job.status, "done");
  assert.equal(result.scene.status, "quality_check");
  assert.equal(result.scene.outputVideoUri, "gs://media/other-output.mp4");
  assert.equal(result.scene.endFrameUri, "gs://media/other-end.jpg");
});

test("a quality_check scene reconciles a nonterminal job without side effects", async () => {
  const harness = makeHarness({
    sceneStatus: "quality_check",
    outputVideoUri: "gs://media/output.mp4",
    endFrameUri: "gs://media/end.jpg",
  });

  const result = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(result.job.status, "done");
  assert.equal(result.job.extractionClaimToken, null);
  assert.equal(harness.counts.provider, 0);
  assert.equal(harness.counts.rendererRequests, 0);
});

test("extraction failure persists genuine error and retains provider output", async () => {
  const harness = makeHarness({
    extractEndFrame: async () => ({
      status: "failed",
      errorCode: "renderer_extract_failed",
    }),
  });

  const failed = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.errorCode, "end_frame_extraction_failed");
  assert.equal(failed.job.extractionClaimToken, null);
  assert.equal(failed.job.extractionFailureCode, null);
  assert.equal(failed.scene.status, "failed");
  assert.equal(failed.scene.outputVideoUri, "gs://media/output.mp4");
  assert.equal(failed.scene.endFrameUri, null);
  assert.equal(harness.counts.extractor, 1);
});

test("legacy failed job recovers provider output before completing scene failure", async () => {
  const harness = makeHarness({
    jobStatus: "failed",
    progress: 100,
    errorCode: "end_frame_extraction_failed",
  });

  const failed = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.errorCode, "end_frame_extraction_failed");
  assert.equal(failed.scene.status, "failed");
  assert.equal(failed.scene.outputVideoUri, "gs://media/output.mp4");
  assert.equal(failed.scene.endFrameUri, null);
  assert.equal(harness.counts.provider, 1);
  assert.equal(harness.counts.rendererRequests, 0);
});

test("an invalid existing artifact fails closed without invoking renderer", async () => {
  const harness = makeHarness({
    findExistingEndFrame: async () => ({
      status: "invalid",
      errorCode: "invalid_extraction_artifact",
    }),
  });

  const failed = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.errorCode, "end_frame_extraction_failed");
  assert.equal(failed.scene.status, "failed");
  assert.equal(harness.counts.rendererRequests, 0);
});

test("permission or transient artifact probe errors do not trigger renderer blindly", async () => {
  for (const message of ["GCS metadata read returned HTTP 403", "GCS metadata read returned HTTP 503"]) {
    const harness = makeHarness({
      findExistingEndFrame: async () => {
        throw new Error(message);
      },
    });

    await assert.rejects(
      pollGenerationJob(harness.job.id, harness.dependencies),
      new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(harness.counts.rendererRequests, 0);
    assert.equal(harness.currentJob().status, "running");
    assert.ok(harness.currentJob().extractionClaimToken);
  }
});

test("Crash D recovers durable failure intent without invoking extraction again", async () => {
  const harness = makeHarness({
    extractionLeaseMs: 100,
    crashAfterFailureIntent: true,
    extractEndFrame: async () => ({
      status: "failed",
      errorCode: "renderer_extract_failed",
    }),
  });

  await assert.rejects(
    pollGenerationJob(harness.job.id, harness.dependencies),
    /simulated process crash/,
  );
  const pending = harness.currentJob();
  assert.equal(pending.status, "running");
  assert.equal(pending.errorCode, null);
  assert.equal(pending.extractionClaimKind, "failure");
  assert.equal(pending.extractionFailureCode, "end_frame_extraction_failed");
  assert.equal(harness.counts.extractor, 1);

  harness.advanceNow(101);
  const recovered = await pollGenerationJob(harness.job.id, harness.dependencies);
  assert.equal(recovered.job.status, "failed");
  assert.equal(recovered.job.errorCode, "end_frame_extraction_failed");
  assert.equal(recovered.scene.status, "failed");
  assert.equal(recovered.scene.outputVideoUri, "gs://media/output.mp4");
  assert.equal(harness.counts.extractor, 1);
});

test("a reconciled terminal job is idempotent and skips provider and renderer", async () => {
  const harness = makeHarness({
    jobStatus: "done",
    progress: 100,
    sceneStatus: "quality_check",
    outputVideoUri: "gs://media/output.mp4",
    endFrameUri: "gs://media/end.jpg",
  });

  const first = await pollGenerationJob(harness.job.id, harness.dependencies);
  const second = await pollGenerationJob(harness.job.id, harness.dependencies);

  assert.equal(first.job.status, "done");
  assert.deepEqual(second, first);
  assert.equal(harness.counts.provider, 0);
  assert.equal(harness.counts.outputChecks, 0);
  assert.equal(harness.counts.rendererRequests, 0);
});

test("public DTO allowlist hides all internal processing metadata", () => {
  const job = makeJob({
    extractionClaimToken: "secret-token",
    extractionClaimKind: "failure",
    extractionClaimExpiresAt: "2026-07-13T01:00:00.000Z",
    extractionFailureCode: "end_frame_extraction_failed",
    stateVersion: 7,
  });

  const dto = toPublicGenerationJob(job);

  assert.equal(dto.errorCode, null);
  assert.equal("extractionClaimToken" in dto, false);
  assert.equal("extractionClaimKind" in dto, false);
  assert.equal("extractionClaimExpiresAt" in dto, false);
  assert.equal("extractionFailureCode" in dto, false);
  assert.equal("stateVersion" in dto, false);
});

function makeHarness(options = {}) {
  let now = options.now ?? Date.parse("2026-07-13T00:00:00.000Z");
  let claimSequence = 0;
  let artifactReady = options.artifactReady ?? false;
  let artifactUri = options.artifactUri ?? "gs://media/end.jpg";
  let remoteOperationRunning = false;
  let crashAfterFailureIntent = options.crashAfterFailureIntent ?? false;
  let failCompletionSceneCas = options.failCompletionSceneCasWithAuthoritativeCompletion ?? false;
  let job = makeJob({
    status: options.jobStatus ?? "running",
    progress: options.progress ?? 64,
    errorCode: options.errorCode ?? null,
    extractionClaimToken: options.claimToken ?? null,
    extractionClaimKind: options.claimToken ? "completion" : null,
    extractionClaimExpiresAt: options.claimToken
      ? new Date(now + (options.claimExpiresAtOffsetMs ?? 600_000)).toISOString()
      : null,
  });
  let scene = makeScene({
    status: options.sceneStatus ?? "generating",
    outputVideoUri: options.outputVideoUri ?? null,
    endFrameUri: options.endFrameUri ?? null,
  });
  const counts = {
    provider: 0,
    outputChecks: 0,
    rendererRequests: 0,
    rendererOperations: 0,
    extractor: 0,
    claimWinners: 0,
    failedJobCas: 0,
    failedSceneCas: 0,
    sceneTerminalTransitions: 0,
    jobTerminalTransitions: 0,
  };

  const dependencies = {
    getJob: async (jobId) => jobId === job.id ? { ...job } : null,
    getScene: async (sceneId) => sceneId === scene.id ? { ...scene } : null,
    transitionJob: async (jobId, expected, patch) => {
      if (
        jobId !== job.id ||
        job.status !== expected.status ||
        job.stateVersion !== expected.stateVersion
      ) {
        counts.failedJobCas += 1;
        return null;
      }
      if (
        patch.extractionClaimToken &&
        patch.extractionClaimToken !== job.extractionClaimToken
      ) {
        counts.claimWinners += 1;
      }
      if (
        ["done", "failed", "canceled"].includes(patch.status) &&
        !["done", "failed", "canceled"].includes(job.status)
      ) {
        counts.jobTerminalTransitions += 1;
      }
      job = {
        ...job,
        ...patch,
        stateVersion: job.stateVersion + 1,
        updatedAt: new Date(now).toISOString(),
      };
      return { ...job };
    },
    transitionScene: async (sceneId, expectedStatus, patch) => {
      if (sceneId !== scene.id || scene.status !== expectedStatus) {
        counts.failedSceneCas += 1;
        return null;
      }
      scene = { ...scene, ...patch };
      if (["quality_check", "failed"].includes(patch.status)) {
        counts.sceneTerminalTransitions += 1;
      }
      return { ...scene };
    },
    transitionSceneForClaim: async (
      sceneId,
      expectedStatus,
      jobId,
      expectedClaimToken,
      expectedClaimKind,
      patch,
    ) => {
      if (
        sceneId !== scene.id ||
        scene.status !== expectedStatus ||
        jobId !== job.id ||
        job.extractionClaimToken !== expectedClaimToken ||
        job.extractionClaimKind !== expectedClaimKind
      ) {
        counts.failedSceneCas += 1;
        return null;
      }
      if (expectedClaimKind === "failure" && crashAfterFailureIntent) {
        crashAfterFailureIntent = false;
        throw new Error("simulated process crash");
      }
      if (failCompletionSceneCas && patch.status === "quality_check") {
        failCompletionSceneCas = false;
        counts.failedSceneCas += 1;
        scene = {
          ...scene,
          status: "quality_check",
          outputVideoUri: "gs://media/other-output.mp4",
          endFrameUri: "gs://media/other-end.jpg",
        };
        return null;
      }
      scene = { ...scene, ...patch };
      if (["quality_check", "failed"].includes(patch.status)) {
        counts.sceneTerminalTransitions += 1;
      }
      return { ...scene };
    },
    pollProvider: async (currentJob) => {
      counts.provider += 1;
      return options.pollProvider
        ? options.pollProvider(currentJob)
        : completedOperation();
    },
    findExistingEndFrame: async (currentJob, outputVideoUri) => {
      counts.outputChecks += 1;
      return options.findExistingEndFrame
        ? options.findExistingEndFrame(currentJob, outputVideoUri)
        : artifactReady
        ? { status: "ready", endFrameUri: artifactUri, generation: "1" }
        : { status: "missing" };
    },
    extractEndFrame: async (currentJob, outputVideoUri) => {
      counts.rendererRequests += 1;
      if (options.dedupeRemoteOperation && remoteOperationRunning) {
        return { status: "processing" };
      }
      remoteOperationRunning = true;
      counts.rendererOperations += 1;
      counts.extractor += 1;
      options.onRendererStarted?.();
      let result;
      if (options.releaseRenderer) {
        await options.releaseRenderer;
        result = { status: "completed", endFrameUri: "gs://media/end.jpg" };
      } else {
        result = options.extractEndFrame
          ? await options.extractEndFrame(currentJob, outputVideoUri)
          : { status: "completed", endFrameUri: "gs://media/end.jpg" };
      }
      remoteOperationRunning = false;
      if (result.status === "completed") {
        artifactReady = true;
        artifactUri = result.endFrameUri;
      }
      return result;
    },
    createClaimToken: () => `claim-${++claimSequence}`,
    now: () => now,
    extractionLeaseMs: options.extractionLeaseMs ?? 600_000,
  };

  return {
    job,
    dependencies,
    counts,
    advanceNow(milliseconds) {
      now += milliseconds;
    },
    currentJob: () => ({ ...job }),
    forceCompleted() {
      job = {
        ...job,
        status: "done",
        progress: 100,
        errorCode: null,
        stateVersion: job.stateVersion + 1,
      };
      scene = {
        ...scene,
        status: "quality_check",
        outputVideoUri: "gs://media/output.mp4",
        endFrameUri: "gs://media/end.jpg",
      };
    },
    forceFailed(errorCode) {
      job = {
        ...job,
        status: "failed",
        progress: 100,
        errorCode,
        stateVersion: job.stateVersion + 1,
      };
      scene = { ...scene, status: "failed" };
    },
  };
}

function makeJob(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "job_test",
    projectId: "prj_test",
    sceneId: "scene_test",
    provider: "google",
    providerOperationId: "operations/test",
    model: "veo-3.1-lite",
    status: "running",
    progress: 64,
    attempt: 1,
    estimatedCostUsd: 0.4,
    errorCode: null,
    extractionClaimToken: null,
    extractionClaimKind: null,
    extractionClaimExpiresAt: null,
    extractionFailureCode: null,
    stateVersion: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeScene(overrides = {}) {
  return {
    id: "scene_test",
    projectId: "prj_test",
    sceneIndex: 1,
    title: "Test scene",
    durationSeconds: 8,
    status: "generating",
    startState: "Start",
    action: "Action",
    endState: "End",
    prompt: "Prompt",
    negativePrompt: "Negative",
    transition: "hard_cut",
    dependsOnSceneId: null,
    startFrameUri: null,
    endFrameUri: null,
    outputVideoUri: null,
    qualityScore: null,
    ...overrides,
  };
}

function completedOperation() {
  return {
    operationId: "operations/test",
    status: "done",
    progress: 100,
    outputVideoUri: "gs://media/output.mp4",
    errorCode: null,
  };
}

function runningOperation() {
  return {
    operationId: "operations/test",
    status: "running",
    progress: 70,
    outputVideoUri: null,
    errorCode: null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
