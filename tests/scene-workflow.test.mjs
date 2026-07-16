import assert from "node:assert/strict";
import test from "node:test";

import {
  canRegenerateScene,
  endFrameExtractionFailure,
  generationSceneTransition,
  parseQcRequest,
  qcSceneTransition,
} from "../lib/scene-workflow.ts";

function makeScene(status = "generating", overrides = {}) {
  return {
    id: "scene_test",
    projectId: "prj_test",
    sceneIndex: 1,
    title: "Test scene",
    durationSeconds: 8,
    status,
    startState: "Start",
    action: "Action",
    endState: "End",
    prompt: "Prompt",
    negativePrompt: "Negative",
    transition: "hard_cut",
    dependsOnSceneId: null,
    startFrameUri: null,
    endFrameUri: "gs://media/old-end.jpg",
    outputVideoUri: "gs://media/old-output.mp4",
    qualityScore: 88,
    ...overrides,
  };
}

test("generation completion moves an active scene to quality_check", () => {
  const scene = makeScene("generating", { endFrameUri: null, outputVideoUri: null });
  const patch = generationSceneTransition(scene, {
    kind: "completed",
    outputVideoUri: "gs://media/new-output.mp4",
    endFrameUri: "gs://media/new-end.jpg",
  });

  assert.deepEqual(patch, {
    status: "quality_check",
    outputVideoUri: "gs://media/new-output.mp4",
    endFrameUri: "gs://media/new-end.jpg",
  });
});

test("extraction failure moves the scene to failed and retains provider output", () => {
  const scene = makeScene("generating", {
    endFrameUri: "gs://media/stale-end.jpg",
    outputVideoUri: null,
  });
  const failure = endFrameExtractionFailure(scene, "gs://media/provider-output.mp4");
  const updated = { ...scene, ...failure.scenePatch };

  assert.equal(failure.errorCode, "end_frame_extraction_failed");
  assert.equal(updated.status, "failed");
  assert.equal(updated.outputVideoUri, "gs://media/provider-output.mp4");
  assert.equal(updated.endFrameUri, null);
});

test("provider failure preserves existing media URIs", () => {
  const scene = makeScene("generating");
  const updated = { ...scene, ...generationSceneTransition(scene, { kind: "failed" }) };

  assert.equal(updated.status, "failed");
  assert.equal(updated.outputVideoUri, scene.outputVideoUri);
  assert.equal(updated.endFrameUri, scene.endFrameUri);
});

test("repeated polling cannot transition reviewed or terminal scenes", () => {
  for (const status of ["quality_check", "approved", "rejected", "failed"]) {
    const scene = makeScene(status);
    assert.equal(
      generationSceneTransition(scene, {
        kind: "completed",
        outputVideoUri: "gs://media/repeated-output.mp4",
        endFrameUri: "gs://media/repeated-end.jpg",
      }),
      null,
      `${status} must be idempotent`,
    );
  }
});

test("completion cannot transition a scene that was never queued", () => {
  assert.equal(
    generationSceneTransition(makeScene("planned"), {
      kind: "completed",
      outputVideoUri: "gs://media/output.mp4",
      endFrameUri: "gs://media/end.jpg",
    }),
    null,
  );
});

test("approve transitions only quality_check and preserves media", () => {
  const scene = makeScene("quality_check");
  const result = qcSceneTransition(scene, "approve");

  assert.deepEqual(result, { ok: true, patch: { status: "approved" } });
  const updated = result.ok ? { ...scene, ...result.patch } : scene;
  assert.equal(updated.outputVideoUri, scene.outputVideoUri);
  assert.equal(updated.endFrameUri, scene.endFrameUri);
});

test("reject transitions only quality_check and preserves media", () => {
  const scene = makeScene("quality_check");
  const result = qcSceneTransition(scene, "reject");

  assert.deepEqual(result, { ok: true, patch: { status: "rejected" } });
  const updated = result.ok ? { ...scene, ...result.patch } : scene;
  assert.equal(updated.outputVideoUri, scene.outputVideoUri);
  assert.equal(updated.endFrameUri, scene.endFrameUri);
});

test("approve rejects a quality_check scene with incomplete media", () => {
  const result = qcSceneTransition(
    makeScene("quality_check", { endFrameUri: null }),
    "approve",
  );

  assert.deepEqual(result, { ok: false, error: "scene_media_not_ready" });
});

test("approve and reject reject every non-quality_check status", () => {
  for (const status of ["planned", "waiting_previous", "queued", "generating", "approved", "rejected", "failed"]) {
    assert.deepEqual(qcSceneTransition(makeScene(status), "approve"), {
      ok: false,
      error: "invalid_scene_transition",
    });
    assert.deepEqual(qcSceneTransition(makeScene(status), "reject"), {
      ok: false,
      error: "invalid_scene_transition",
    });
  }
});

test("QC request parser trims reason and rejects more than 500 characters", () => {
  assert.deepEqual(parseQcRequest({ decision: "reject", reason: "  needs revision  " }), {
    decision: "reject",
    reason: "needs revision",
  });
  assert.equal(parseQcRequest({ decision: "reject", reason: "a".repeat(501) }), null);
  assert.equal(parseQcRequest({ decision: "approve", reason: "not allowed" }), null);
});

test("approved, rejected and failed are regeneratable while quality_check is not", () => {
  assert.equal(canRegenerateScene("approved"), true);
  assert.equal(canRegenerateScene("rejected"), true);
  assert.equal(canRegenerateScene("failed"), true);
  assert.equal(canRegenerateScene("quality_check"), false);
});
