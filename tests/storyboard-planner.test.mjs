import assert from "node:assert/strict";
import test from "node:test";

import { compileScenePrompt } from "../lib/prompt-compiler.ts";
import {
  planDeterministicStoryboard,
  STORYBOARD_PLANNER_VERSION,
} from "../lib/storyboard-planner.ts";

const project = {
  id: "prj_planner_test",
  ownerId: "planner@example.com",
  name: "Coffee truth",
  brief: "A Vietnamese barista pours latte art in a warm walnut coffee shop.",
  template: "KOC review",
  aspectRatio: "9:16",
  targetDurationSeconds: 30,
  model: "veo-3.1-fast",
  status: "draft",
  storyBible: {
    characterLock: "Vietnamese barista, black bob hair, beige linen shirt, dark brown apron.",
    productLock: "White 180 ml cup with a cobalt rim, no text, no logo.",
    environmentLock: "Small coffee shop with walnut counter and copper espresso machine.",
    lightingLock: "Warm 7 AM light always enters from camera left.",
    visualStyle: "Photorealistic warm cinematic commercial with shallow depth of field.",
    audioDirection: "Natural coffee shop room tone without dialogue.",
    mustAvoid: ["identity drift", "cup deformation", "extra hands"],
  },
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

test("deterministic planner creates four structured Scene Contracts", () => {
  const plan = createPlan();
  assert.equal(STORYBOARD_PLANNER_VERSION, "deterministic-storyboard-v2");
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((scene) => scene.contract.sceneIndex), [1, 2, 3, 4]);
  assert.deepEqual(
    plan.map((scene) => scene.contract.generationMode),
    ["text_to_video", "first_frame", "first_frame", "first_frame"],
  );
  for (const planned of plan) {
    assert.equal(planned.contract.version, 2);
    assert.equal(planned.contract.stableEndSeconds, 0.75);
    assert.equal(planned.contract.visualStyle, project.storyBible.visualStyle);
    assert.equal(planned.contract.audioDirection, project.storyBible.audioDirection);
    assert.ok(planned.contract.continuityLocks.length >= 5);
    assert.match(planned.contract.primaryAction, /Vietnamese barista pours latte art/i);
  }
});

test("each downstream Scene Contract starts from the previous authoritative end state", () => {
  const plan = createPlan();
  for (let index = 1; index < plan.length; index += 1) {
    assert.deepEqual(plan[index].contract.startState, plan[index - 1].contract.endState);
    assert.notEqual(plan[index].contract.startState, plan[index - 1].contract.endState);
  }
});

test("text-to-video prompt contains the concrete Story Bible locks", () => {
  const [first] = createPlan();
  const compilation = compileScenePrompt(first.contract);
  assert.match(compilation.prompt, new RegExp(escapeRegExp(project.storyBible.characterLock)));
  assert.match(compilation.prompt, new RegExp(escapeRegExp(project.storyBible.productLock)));
  assert.match(compilation.prompt, new RegExp(escapeRegExp(project.storyBible.environmentLock)));
  assert.match(compilation.prompt, new RegExp(escapeRegExp(project.storyBible.lightingLock)));
  assert.match(compilation.prompt, new RegExp(escapeRegExp(project.storyBible.visualStyle)));
  assert.match(compilation.prompt, new RegExp(escapeRegExp(project.storyBible.audioDirection)));
  assert.doesNotMatch(compilation.prompt, /reference (?:image|asset|input)|ảnh tham chiếu|ảnh tải lên/i);
});

test("same planner inputs and stable ID factory produce identical contracts", () => {
  assert.deepEqual(createPlan(), createPlan());
});

function createPlan() {
  return planDeterministicStoryboard(project, {
    createSceneId: (sceneIndex) => `scene_planned_${sceneIndex}`,
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
