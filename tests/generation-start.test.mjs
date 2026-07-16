import assert from "node:assert/strict";
import test from "node:test";

import { startGeneration } from "../lib/generation-start.ts";
import { ProviderSubmissionError } from "../lib/provider-submission.ts";

test("two concurrent requests produce one reservation, debit, submit, and activation", async () => {
  const submitStarted = deferred();
  const releaseSubmit = deferred();
  const harness = makeHarness({
    submit: async () => {
      submitStarted.resolve();
      await releaseSubmit.promise;
      return queuedOperation("operation-one");
    },
  });

  const first = harness.start("scene-1");
  const second = harness.start("scene-1");
  await submitStarted.promise;
  const loser = await Promise.race([first, second]);

  assert.equal(loser.ok, true);
  assert.equal(loser.reused, true);
  assert.equal(harness.counts.reservationWinners, 1);
  assert.equal(harness.counts.claimWinners, 1);
  assert.equal(harness.counts.creditDebits, 1);
  assert.equal(harness.counts.providerSubmits, 1);

  releaseSubmit.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].job.id, results[1].job.id);
  assert.equal(harness.counts.activations, 1);
  assert.equal(harness.jobs.size, 1);
});

test("an active job on another scene blocks project-wide admission", async () => {
  const harness = makeHarness({
    scenes: [scene("scene-1", 1), scene("scene-2", 2)],
    jobs: [job({ id: "active-other", sceneId: "scene-1", status: "running" })],
  });

  const result = await harness.start("scene-2");

  assert.equal(result.ok, false);
  assert.equal(result.error, "project_generation_in_progress");
  assert.equal(harness.counts.providerSubmits, 0);
  assert.equal(harness.counts.creditDebits, 0);
});

test("a stale running reservation without an operation fails closed", async () => {
  const harness = makeHarness({
    now: Date.parse("2026-07-16T12:10:00.000Z"),
    jobs: [
      job({
        id: "unknown-submit",
        sceneId: "scene-1",
        status: "running",
        updatedAt: "2026-07-16T12:00:00.000Z",
      }),
    ],
  });

  const result = await harness.start("scene-1");

  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_submission_uncertain");
  assert.equal(harness.counts.providerSubmits, 0);
  assert.equal(harness.jobs.get("unknown-submit").providerOperationId, null);
});

test("definitive provider rejection refunds credit and preserves scene media", async () => {
  const target = scene("scene-1", 1, {
    status: "approved",
    outputVideoUri: "mock://old.mp4",
    endFrameUri: "mock://old-last.jpg",
    qualityScore: 94,
  });
  const downstream = scene("scene-2", 2, {
    status: "approved",
    outputVideoUri: "mock://downstream.mp4",
    endFrameUri: "mock://downstream-last.jpg",
  });
  const harness = makeHarness({
    scenes: [target, downstream],
    submit: async () => {
      throw new ProviderSubmissionError(
        "request rejected",
        "provider_submission_rejected",
        false,
      );
    },
  });

  const result = await harness.start(target.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_submission_failed");
  assert.equal(result.refundedCredits, 4);
  assert.equal(harness.balance, 100);
  assert.equal(harness.counts.creditDebits, 1);
  assert.equal(harness.counts.creditRefunds, 1);
  assert.equal(harness.scenes.get(target.id).status, "approved");
  assert.equal(harness.scenes.get(target.id).outputVideoUri, "mock://old.mp4");
  assert.equal(harness.scenes.get(downstream.id).status, "approved");
});

test("successful regeneration increments attempt and invalidates media atomically", async () => {
  const target = scene("scene-1", 1, {
    status: "rejected",
    outputVideoUri: "mock://old.mp4",
    endFrameUri: "mock://old-last.jpg",
  });
  const downstream = scene("scene-2", 2, {
    status: "quality_check",
    startFrameUri: "mock://old-last.jpg",
    outputVideoUri: "mock://downstream.mp4",
    endFrameUri: "mock://downstream-last.jpg",
  });
  const harness = makeHarness({
    scenes: [target, downstream],
    jobs: [job({ id: "previous", sceneId: target.id, status: "done", attempt: 1 })],
  });

  const result = await harness.start(target.id);

  assert.equal(result.ok, true);
  assert.equal(result.job.attempt, 2);
  assert.equal(harness.scenes.get(target.id).status, "queued");
  assert.equal(harness.scenes.get(target.id).outputVideoUri, null);
  assert.equal(harness.scenes.get(target.id).endFrameUri, null);
  assert.equal(harness.scenes.get(downstream.id).status, "waiting_previous");
  assert.equal(harness.scenes.get(downstream.id).startFrameUri, null);
  assert.equal(harness.scenes.get(downstream.id).outputVideoUri, null);
  assert.equal(harness.counts.downstreamInvalidations, 1);
});

test("quality_check is blocked without reservation or provider work", async () => {
  const harness = makeHarness({ scenes: [scene("scene-1", 1, { status: "quality_check" })] });

  const result = await harness.start("scene-1");

  assert.equal(result.ok, false);
  assert.equal(result.error, "scene_requires_qc_decision");
  assert.equal(harness.counts.reservationWinners, 0);
  assert.equal(harness.counts.providerSubmits, 0);
});

test("a dependent scene submits with the approved previous end frame", async () => {
  let submittedStartFrame;
  const previous = scene("scene-1", 1, {
    status: "approved",
    endFrameUri: "mock://scene-1-last.jpg",
    outputVideoUri: "mock://scene-1.mp4",
  });
  const dependent = scene("scene-2", 2, {
    status: "waiting_previous",
    dependsOnSceneId: previous.id,
  });
  const harness = makeHarness({
    scenes: [previous, dependent],
    submit: async (request) => {
      submittedStartFrame = request.startFrameUri;
      return queuedOperation("continuity-operation");
    },
  });

  const result = await harness.start(dependent.id);

  assert.equal(result.ok, true);
  assert.equal(submittedStartFrame, previous.endFrameUri);
});

function makeHarness(options = {}) {
  const now = options.now ?? Date.parse("2026-07-16T12:00:00.000Z");
  const project = {
    id: "project-1",
    ownerId: "owner@example.com",
    name: "Project",
    brief: "Brief",
    template: "commercial",
    aspectRatio: "16:9",
    targetDurationSeconds: 16,
    model: "veo-3.1-lite",
    status: "planning",
    storyBible: {
      characterLock: "",
      productLock: "",
      environmentLock: "",
      lightingLock: "",
      visualStyle: "",
      audioDirection: "",
      mustAvoid: [],
    },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  const scenes = new Map(
    (options.scenes ?? [scene("scene-1", 1)]).map((item) => [item.id, structuredClone(item)]),
  );
  const jobs = new Map((options.jobs ?? []).map((item) => [item.id, structuredClone(item)]));
  const counts = {
    reservationWinners: 0,
    claimWinners: 0,
    creditDebits: 0,
    creditRefunds: 0,
    providerSubmits: 0,
    activations: 0,
    downstreamInvalidations: 0,
  };
  let balance = 100;
  const charged = new Map();
  const refunded = new Set();
  const provider = {
    name: "mock",
    async submit(request) {
      counts.providerSubmits += 1;
      return options.submit
        ? options.submit(request)
        : queuedOperation(`operation-${counts.providerSubmits}`);
    },
    async poll() {
      throw new Error("not used");
    },
    async cancel() {},
  };

  const dependencies = {
    now: () => now,
    createJobId: () => `job-${jobs.size + 1}`,
    async getScene(ownerId, sceneId) {
      return ownerId === project.ownerId ? scenes.get(sceneId) ?? null : null;
    },
    async getProject(ownerId, projectId) {
      return ownerId === project.ownerId && projectId === project.id ? project : null;
    },
    async getJob(ownerId, jobId) {
      return ownerId === project.ownerId ? jobs.get(jobId) ?? null : null;
    },
    async reserve(ownerId, input) {
      if (ownerId !== project.ownerId || input.projectId !== project.id) {
        return { kind: "blocked", error: "project_not_found" };
      }
      const target = scenes.get(input.sceneId);
      if (!target) return { kind: "blocked", error: "scene_not_found" };
      const active = [...jobs.values()].find(
        (item) => item.status === "queued" || item.status === "running",
      );
      if (active) {
        return active.sceneId === target.id
          ? { kind: "reused", job: active, project, scene: target }
          : { kind: "blocked", error: "project_generation_in_progress", job: active };
      }
      if (target.status === "quality_check") {
        return { kind: "blocked", error: "scene_requires_qc_decision" };
      }
      let submissionScene = target;
      if (target.dependsOnSceneId) {
        const previous = scenes.get(target.dependsOnSceneId);
        if (!previous || previous.status !== "approved" || !previous.endFrameUri) {
          return { kind: "blocked", error: "previous_scene_not_approved" };
        }
        submissionScene = { ...target, startFrameUri: previous.endFrameUri };
      }
      const attempt = [...jobs.values()]
        .filter((item) => item.sceneId === target.id)
        .reduce((maximum, item) => Math.max(maximum, item.attempt), 0) + 1;
      if (balance < input.requiredCredits) {
        return {
          kind: "blocked",
          error: "insufficient_credits",
          requiredCredits: input.requiredCredits,
          balance,
        };
      }
      const reserved = job({
        id: input.jobId,
        sceneId: target.id,
        status: "queued",
        attempt,
        provider: input.provider,
        estimatedCostUsd: input.estimatedCostUsd,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      jobs.set(reserved.id, reserved);
      balance -= input.requiredCredits;
      charged.set(reserved.id, input.requiredCredits);
      counts.creditDebits += 1;
      counts.reservationWinners += 1;
      return {
        kind: "reserved",
        job: reserved,
        project,
        scene: submissionScene,
        balanceAfter: balance,
      };
    },
    async transitionJob(ownerId, jobId, expected, patch) {
      const current = jobs.get(jobId);
      if (
        ownerId !== project.ownerId ||
        !current ||
        current.status !== expected.status ||
        current.stateVersion !== expected.stateVersion
      ) {
        return null;
      }
      const updated = {
        ...current,
        ...patch,
        stateVersion: current.stateVersion + 1,
        updatedAt: new Date(now).toISOString(),
      };
      jobs.set(jobId, updated);
      if (current.status === "queued" && patch.status === "running") {
        counts.claimWinners += 1;
      }
      return updated;
    },
    async activate(ownerId, input) {
      const current = jobs.get(input.jobId);
      const target = current ? scenes.get(current.sceneId) : null;
      if (
        ownerId !== project.ownerId ||
        !current ||
        !target ||
        current.status !== "running" ||
        current.stateVersion !== input.expectedStateVersion ||
        current.providerOperationId !== null ||
        target.status !== input.expectedSceneStatus
      ) {
        return null;
      }
      const updated = {
        ...current,
        providerOperationId: input.operation.operationId,
        status: input.operation.status,
        progress: input.operation.progress,
        stateVersion: current.stateVersion + 1,
        updatedAt: new Date(now).toISOString(),
      };
      jobs.set(current.id, updated);
      scenes.set(target.id, {
        ...target,
        status: "queued",
        outputVideoUri: null,
        endFrameUri: null,
        qualityScore: null,
      });
      if (["approved", "rejected", "failed"].includes(target.status)) {
        for (const downstream of scenes.values()) {
          if (downstream.sceneIndex <= target.sceneIndex) continue;
          scenes.set(downstream.id, {
            ...downstream,
            status: "waiting_previous",
            startFrameUri: null,
            outputVideoUri: null,
            endFrameUri: null,
            qualityScore: null,
          });
          counts.downstreamInvalidations += 1;
        }
      }
      counts.activations += 1;
      return updated;
    },
    async failAndRefund(ownerId, input) {
      const current = jobs.get(input.jobId);
      if (
        ownerId !== project.ownerId ||
        !current ||
        current.status !== "running" ||
        current.stateVersion !== input.expectedStateVersion ||
        current.providerOperationId !== null
      ) {
        return null;
      }
      const failed = {
        ...current,
        status: "failed",
        progress: 0,
        errorCode: input.errorCode,
        stateVersion: current.stateVersion + 1,
        updatedAt: new Date(now).toISOString(),
      };
      jobs.set(current.id, failed);
      if (!refunded.has(current.id)) {
        balance += charged.get(current.id) ?? 0;
        refunded.add(current.id);
        counts.creditRefunds += 1;
      }
      return { job: failed, balanceAfter: balance };
    },
  };

  return {
    project,
    scenes,
    jobs,
    counts,
    get balance() {
      return balance;
    },
    start(sceneId) {
      return startGeneration(project.ownerId, sceneId, provider, dependencies);
    },
  };
}

function scene(id, sceneIndex, patch = {}) {
  return {
    id,
    projectId: "project-1",
    sceneIndex,
    title: `Scene ${sceneIndex}`,
    durationSeconds: 8,
    status: "planned",
    startState: "start",
    action: "action",
    endState: "end",
    prompt: "prompt",
    negativePrompt: "negative",
    transition: "hard_cut",
    dependsOnSceneId: null,
    startFrameUri: null,
    endFrameUri: null,
    outputVideoUri: null,
    qualityScore: null,
    ...patch,
  };
}

function job(patch = {}) {
  const timestamp = "2026-07-16T12:00:00.000Z";
  return {
    id: "job-1",
    projectId: "project-1",
    sceneId: "scene-1",
    provider: "mock",
    providerOperationId: null,
    model: "veo-3.1-lite",
    status: "queued",
    progress: 0,
    attempt: 1,
    estimatedCostUsd: 0.4,
    errorCode: null,
    extractionClaimToken: null,
    extractionClaimKind: null,
    extractionClaimExpiresAt: null,
    extractionFailureCode: null,
    stateVersion: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

function queuedOperation(operationId) {
  return {
    operationId,
    status: "queued",
    progress: 0,
    outputVideoUri: null,
    errorCode: null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
