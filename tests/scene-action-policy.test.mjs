import assert from "node:assert/strict";
import test from "node:test";

import {
  getPipelineActionPolicy,
  getSceneActionPolicy,
} from "../app/components/scene-action-policy.ts";

test("quality_check exposes only approve and reject actions", () => {
  const target = scene("scene-1", 1, {
    status: "quality_check",
    outputVideoUri: "mock://scene-1.mp4",
    endFrameUri: "mock://scene-1-last-frame.jpg",
  });
  const policy = getSceneActionPolicy(target, [target], false);

  assert.equal(policy.canApprove, true);
  assert.equal(policy.canReject, true);
  assert.equal(policy.canGenerate, false);
  assert.equal(policy.generationLabel, "Chờ quyết định QC");
});

test("quality_check disables approve until both video and continuity frame are ready", () => {
  for (const patch of [
    { outputVideoUri: "mock://scene-1.mp4", endFrameUri: null },
    { outputVideoUri: null, endFrameUri: "mock://scene-1-last-frame.jpg" },
  ]) {
    const target = scene("scene-1", 1, { status: "quality_check", ...patch });
    const policy = getSceneActionPolicy(target, [target], false);

    assert.equal(policy.canApprove, false);
    assert.equal(policy.canReject, true);
    assert.equal(policy.canGenerate, false);
    assert.equal(policy.lockedReason, "Video hoặc frame continuity chưa sẵn sàng để duyệt.");
  }
});

test("approving the previous scene unlocks generation for its dependent scene", () => {
  const previous = scene("scene-1", 1, { status: "quality_check" });
  const dependent = scene("scene-2", 2, {
    status: "waiting_previous",
    dependsOnSceneId: previous.id,
  });

  const locked = getSceneActionPolicy(dependent, [previous, dependent], false);
  assert.equal(locked.canGenerate, false);
  assert.equal(locked.generationLabel, "Chờ cảnh trước");

  const approved = { ...previous, status: "approved" };
  const unlocked = getSceneActionPolicy(dependent, [approved, dependent], false);
  assert.equal(unlocked.canGenerate, true);
  assert.equal(unlocked.generationLabel, "Tạo cảnh");
});

test("rejecting a scene keeps its dependent locked while allowing regeneration", () => {
  const first = scene("scene-1", 1, { status: "approved" });
  const rejected = scene("scene-2", 2, {
    status: "rejected",
    dependsOnSceneId: first.id,
  });
  const dependent = scene("scene-3", 3, {
    status: "waiting_previous",
    dependsOnSceneId: rejected.id,
  });

  assert.equal(getSceneActionPolicy(rejected, [first, rejected, dependent], false).canGenerate, true);
  assert.equal(getSceneActionPolicy(dependent, [first, rejected, dependent], false).canGenerate, false);
});

test("approved, rejected and failed scenes are regeneratable when continuity is ready", () => {
  for (const status of ["approved", "rejected", "failed"]) {
    const target = scene(`scene-${status}`, 1, { status });
    const policy = getSceneActionPolicy(target, [target], false);
    assert.equal(policy.canGenerate, true, status);
    assert.equal(policy.generationLabel, "Tạo lại", status);
  }
});

test("a project-wide active generation disables every new generation action", () => {
  const target = scene("scene-1", 1, { status: "planned" });
  const policy = getSceneActionPolicy(target, [target], true);

  assert.equal(policy.canGenerate, false);
  assert.equal(policy.generationLabel, "Đang có cảnh chạy");
});

test("pipeline stops at manual QC instead of selecting a generation target", () => {
  const approved = scene("scene-1", 1, { status: "approved" });
  const reviewing = scene("scene-2", 2, {
    status: "quality_check",
    dependsOnSceneId: approved.id,
    outputVideoUri: "mock://scene-2.mp4",
    endFrameUri: "mock://scene-2-last-frame.jpg",
  });
  const waiting = scene("scene-3", 3, {
    status: "waiting_previous",
    dependsOnSceneId: reviewing.id,
  });

  const action = getPipelineActionPolicy([approved, reviewing, waiting], false);
  assert.equal(action.kind, "wait_for_qc");
  assert.equal(action.scene.id, reviewing.id);
});

test("pipeline never selects another scene while generation is active", () => {
  const approved = scene("scene-1", 1, { status: "approved" });
  const generating = scene("scene-2", 2, {
    status: "generating",
    dependsOnSceneId: approved.id,
  });
  const waiting = scene("scene-3", 3, {
    status: "waiting_previous",
    dependsOnSceneId: generating.id,
  });

  const action = getPipelineActionPolicy([approved, generating, waiting], false);
  assert.equal(action.kind, "wait_for_generation");
  assert.equal(action.scene.id, generating.id);
  assert.equal(action.reason, "Cảnh 2 đang được tạo. Pipeline sẽ không gửi thêm cảnh.");

  const stalePlannedScene = scene("scene-stale", 1, { status: "planned" });
  const projectActiveAction = getPipelineActionPolicy([stalePlannedScene], true);
  assert.equal(projectActiveAction.kind, "wait_for_generation");
  assert.equal(projectActiveAction.scene.id, stalePlannedScene.id);
  assert.equal(
    projectActiveAction.reason,
    "Dự án đang có một cảnh được tạo. Pipeline sẽ không gửi thêm cảnh.",
  );
});

test("pipeline selects only the first continuity-ready scene", () => {
  const approved = scene("scene-1", 1, {
    status: "approved",
    endFrameUri: "mock://scene-1-last-frame.jpg",
  });
  const ready = scene("scene-2", 2, {
    status: "waiting_previous",
    dependsOnSceneId: approved.id,
  });
  const waiting = scene("scene-3", 3, {
    status: "waiting_previous",
    dependsOnSceneId: ready.id,
  });

  const action = getPipelineActionPolicy([approved, ready, waiting], false);
  assert.equal(action.kind, "generate");
  assert.equal(action.scene.id, ready.id);
});

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
