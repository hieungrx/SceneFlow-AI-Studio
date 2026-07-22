import assert from "node:assert/strict";
import test from "node:test";

import {
  compileScenePrompt,
  formatNegativePrompt,
  lintCompiledPrompt,
  lintSceneContract,
  SCENE_PROMPT_COMPILER_VERSION,
  ScenePromptLintError,
} from "../lib/prompt-compiler.ts";

const state = {
  subjectState: "The same Vietnamese barista with black bob hair and a beige linen shirt.",
  productState: "The same white 180 ml cup with a cobalt rim and no logo.",
  environmentState: "The same walnut coffee counter and copper espresso machine.",
  lightingState: "Warm morning key light remains on camera left.",
  cameraState: "Stable medium composition.",
  compositionState: "The cup occupies the central priority area.",
};

test("compiles text-to-video with concrete visual truth", () => {
  const contract = sceneContract("text_to_video");
  const first = compileScenePrompt(contract);
  const repeated = compileScenePrompt(contract);

  assert.deepEqual(repeated, first);
  assert.equal(first.compilerVersion, SCENE_PROMPT_COMPILER_VERSION);
  assert.match(first.prompt, new RegExp(escapeRegExp(state.subjectState)));
  assert.match(first.prompt, new RegExp(escapeRegExp(state.productState)));
  assert.match(first.prompt, new RegExp(escapeRegExp(state.environmentState)));
  assert.match(first.prompt, new RegExp(escapeRegExp(state.lightingState)));
  assert.match(first.prompt, /Visual style: Photorealistic warm cinematic commercial/i);
  assert.match(first.prompt, /Audio direction: Natural coffee shop room tone without dialogue/i);
  assert.equal(first.targetProvider, "google_veo");
  assert.equal(first.compilerConfig.visualStylePolicy, "explicit");
  assert.equal(first.compilerConfig.audioDirectionPolicy, "explicit");
});

test("compiles first-frame as motion-focused guidance", () => {
  const compilation = compileScenePrompt(sceneContract("first_frame"));
  assert.match(compilation.prompt, /supplied first frame as the authoritative visual state/i);
  assert.match(compilation.prompt, /Primary action:/);
  assert.doesNotMatch(compilation.prompt, new RegExp(escapeRegExp(state.productState)));
  assert.match(compilation.prompt, /Visual style continuity:/i);
  assert.match(compilation.prompt, /Natural coffee shop room tone without dialogue/i);
  assert.doesNotMatch(
    compilation.prompt,
    /Photorealistic warm cinematic commercial with shallow depth of field/i,
  );
  assert.equal(compilation.lintIssues.some((issue) => issue.code === "redundant_image_prompt"), false);
});

test("compiles first-last-frame as a controlled boundary transition", () => {
  const contract = sceneContract("first_last_frame");
  contract.endState = {
    ...contract.endState,
    cameraState: "Locked close hero frame.",
    compositionState: "The cup settles in the lower center.",
  };
  const compilation = compileScenePrompt(contract);
  assert.match(compilation.prompt, /supplied first and last frames/i);
  assert.match(compilation.prompt, /Required boundary changes:/);
  assert.match(compilation.prompt, /Arrive at the supplied last frame smoothly/i);
  assert.match(compilation.prompt, /Natural coffee shop room tone without dialogue/i);
});

test("compiles reference-guided without claiming or binding real references", () => {
  const compilation = compileScenePrompt(sceneContract("reference_guided"));
  assert.match(compilation.prompt, /bound reference inputs as the authority/i);
  assert.match(compilation.prompt, /without restating the reference content/i);
  assert.match(compilation.prompt, /Natural coffee shop room tone without dialogue/i);
  assert.doesNotMatch(compilation.prompt, /gs:\/\//i);
});

test("formats negative prompts per target provider", () => {
  assert.equal(formatNegativePrompt("google_veo", ["flicker", "text"]), "flicker, text");
  assert.equal(formatNegativePrompt("mock", ["flicker", "text"]), "Avoid: flicker | text");
});

test("rejects conflicting camera instructions and multiple actions", () => {
  const contract = sceneContract("text_to_video");
  contract.primaryAction = "Lift the cup, then rotate it, then set it down, then reveal the label.";
  contract.cameraMotion = "locked camera with zoom in and pan left";
  const issues = lintSceneContract(contract);
  assert.ok(issues.some((issue) => issue.code === "multiple_primary_actions"));
  assert.ok(issues.some((issue) => issue.code === "excessive_sequential_actions"));
  assert.ok(issues.some((issue) => issue.code === "locked_camera_motion_conflict"));
  assert.throws(() => compileScenePrompt(contract), ScenePromptLintError);
});

test("flags mutually opposed camera motion, missing stable end, and missing locks", () => {
  const contract = sceneContract("text_to_video");
  contract.cameraMotion = "pan left and pan right";
  contract.stableEndSeconds = 0;
  contract.continuityLocks = [];
  const codes = lintSceneContract(contract).map((issue) => issue.code);
  assert.ok(codes.includes("conflicting_camera_instructions"));
  assert.ok(codes.includes("missing_stable_end_state"));
  assert.ok(codes.includes("missing_continuity_locks"));
});

test("flags an image prompt that redundantly repeats all static state", () => {
  const contract = sceneContract("first_frame");
  const redundantPrompt = Object.values(contract.startState).join(" ");
  const issues = lintCompiledPrompt(contract, redundantPrompt);
  assert.equal(issues[0]?.code, "redundant_image_prompt");
});

function sceneContract(generationMode) {
  return {
    version: 2,
    sceneId: "scene_contract_test",
    sceneIndex: 1,
    goal: "Show the product truth in one controlled shot.",
    startState: { ...state },
    endState: { ...state },
    primaryAction: "Lift the cup once.",
    subjectMotion: "The subject lifts the cup with one natural movement.",
    cameraMotion: "slow dolly in",
    environmentMotion: "Only subtle continuous steam moves in the background.",
    backgroundPolicy: "controlled_motion",
    visualStyle: "Photorealistic warm cinematic commercial with shallow depth of field.",
    audioDirection: "Natural coffee shop room tone without dialogue.",
    continuityLocks: [
      `Character: ${state.subjectState}`,
      `Product: ${state.productState}`,
      `Environment: ${state.environmentState}`,
      `Lighting: ${state.lightingState}`,
    ],
    negativeConstraints: ["new objects", "logo mutation"],
    generationMode,
    riskFactors: ["hands_or_fingers"],
    stableEndSeconds: 0.75,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
