import type {
  AspectRatio,
  GenerationMode,
  PromptCompilation,
  PromptLintIssue,
  PromptTargetProvider,
  SceneContract,
  ScenePromptCompilerConfig,
  ScenePromptCompilation,
  StructuredVisualState,
  VideoModel,
} from "./types";

type CompileBriefPreviewInput = {
  rawPrompt: string;
  aspectRatio?: AspectRatio;
  durationSeconds?: 4 | 6 | 8;
  model?: VideoModel;
};

type CompileScenePromptOptions = {
  targetProvider?: PromptTargetProvider;
};

export const BRIEF_PREVIEW_COMPILER_VERSION = "deterministic-brief-preview-v1";
export const SCENE_PROMPT_COMPILER_VERSION = "scene-contract-prompt-v2";

const BASE_NEGATIVE_CONSTRAINTS = [
  "identity drift",
  "product deformation",
  "duplicated objects",
  "distorted hands",
  "unreadable text",
  "flicker",
  "abrupt camera jumps",
] as const;

export class ScenePromptLintError extends Error {
  readonly issues: PromptLintIssue[];

  constructor(issues: PromptLintIssue[]) {
    super("Scene Contract failed deterministic prompt lint.");
    this.name = "ScenePromptLintError";
    this.issues = issues;
  }
}

export function compileBriefPreview(input: CompileBriefPreviewInput): PromptCompilation {
  const rawPrompt = input.rawPrompt.trim();
  const aspectRatio = input.aspectRatio ?? "9:16";
  const durationSeconds = input.durationSeconds ?? 8;
  const model = input.model ?? "veo-3.1-lite";
  const assumptions: string[] = [];
  const clarificationQuestions: string[] = [];

  if (rawPrompt.length < 24) {
    clarificationQuestions.push("Chủ thể chính đang làm hành động gì trong cảnh này?");
  }
  if (!/dọc|ngang|9:16|16:9/i.test(rawPrompt)) {
    assumptions.push(`Dùng khung hình ${aspectRatio} theo cấu hình dự án.`);
  }
  if (!/âm thanh|tiếng|voice|thoại|nhạc/i.test(rawPrompt)) {
    assumptions.push("Dùng âm thanh môi trường tự nhiên, không tự thêm lời thoại.");
  }

  const orientation = aspectRatio === "9:16" ? "vertical 9:16" : "landscape 16:9";
  return {
    intent: rawPrompt || "Tạo video quảng cáo sản phẩm có tính điện ảnh",
    lockedFields: ["chủ thể", "sản phẩm", "bối cảnh", "ánh sáng", "tỷ lệ khung hình"],
    assumptions,
    clarificationQuestions,
    optimizedPromptEn: [
      `Deterministic planning preview for a ${durationSeconds}-second ${orientation} scene.`,
      `User intent: ${rawPrompt || "A product-focused visual story"}.`,
      "The versioned storyboard planner will convert this brief and the Story Bible into four Scene Contracts.",
    ].join(" "),
    negativePrompt: formatNegativePrompt("google_veo", BASE_NEGATIVE_CONSTRAINTS),
    compiler: {
      kind: "deterministic_rules",
      version: BRIEF_PREVIEW_COMPILER_VERSION,
      label: "Bộ biên dịch quy tắc xác định",
    },
    config: { aspectRatio, durationSeconds, model },
  };
}

export function compileScenePrompt(
  contract: SceneContract,
  options: CompileScenePromptOptions = {},
): ScenePromptCompilation {
  const contractIssues = lintSceneContract(contract);
  const blockingIssues = contractIssues.filter((issue) => issue.severity === "error");
  if (blockingIssues.length > 0) throw new ScenePromptLintError(contractIssues);

  const prompt = compilerForMode(contract.generationMode)(contract);
  const lintIssues = [...contractIssues, ...lintCompiledPrompt(contract, prompt)];
  const provider = options.targetProvider ?? "google_veo";
  const compilerConfig = compilerConfigFor(contract.generationMode, provider);
  return {
    compilerVersion: SCENE_PROMPT_COMPILER_VERSION,
    deterministic: true,
    generationMode: contract.generationMode,
    targetProvider: provider,
    compilerConfig,
    prompt,
    negativePrompt: formatNegativePrompt(provider, [
      ...BASE_NEGATIVE_CONSTRAINTS,
      ...contract.negativeConstraints,
    ]),
    lintIssues,
  };
}

export function lintSceneContract(contract: SceneContract): PromptLintIssue[] {
  const issues: PromptLintIssue[] = [];
  const sequentialActionCount = countSequentialActions(contract.primaryAction);
  if (sequentialActionCount > 0) {
    issues.push(issue(
      "multiple_primary_actions",
      "error",
      "Primary action contains a sequence; keep exactly one primary action per scene.",
    ));
  }
  if (sequentialActionCount > 2) {
    issues.push(issue(
      "excessive_sequential_actions",
      "error",
      "Scene action contains too many sequential steps.",
    ));
  }

  const cameraMotion = contract.cameraMotion.toLowerCase();
  if (hasConflictingCameraInstructions(cameraMotion)) {
    issues.push(issue(
      "conflicting_camera_instructions",
      "error",
      "Camera motion contains mutually conflicting directions.",
    ));
  }
  if (
    /\b(?:locked|static|khóa|cố định)\b/.test(cameraMotion) &&
    /\b(?:zoom|pan|rotate|rotation|dolly|track|tilt|orbit|truck)\b/.test(cameraMotion)
  ) {
    issues.push(issue(
      "locked_camera_motion_conflict",
      "error",
      "Locked camera cannot be combined with zoom, pan, rotation, or translation.",
    ));
  }

  if (contract.stableEndSeconds <= 0 || hasEmptyVisualState(contract.endState)) {
    issues.push(issue(
      "missing_stable_end_state",
      "error",
      "Scene must define a complete, stable end state.",
    ));
  }
  if (contract.continuityLocks.length === 0) {
    issues.push(issue(
      "missing_continuity_locks",
      "error",
      "Scene Contract must include authoritative continuity locks.",
    ));
  }
  if (contract.continuityLocks.some(isGenericLock)) {
    issues.push(issue(
      "generic_story_bible_lock",
      "warning",
      "At least one Story Bible continuity lock is empty or generic.",
    ));
  }
  if (!contract.visualStyle.trim()) {
    issues.push(issue(
      "missing_visual_style",
      "error",
      "Scene Contract must preserve a concrete visual style direction.",
    ));
  }
  if (!contract.audioDirection.trim()) {
    issues.push(issue(
      "missing_audio_direction",
      "error",
      "Scene Contract must preserve a concrete audio direction.",
    ));
  }
  return issues;
}

export function lintCompiledPrompt(
  contract: SceneContract,
  prompt: string,
): PromptLintIssue[] {
  if (contract.generationMode === "text_to_video") return [];
  const normalizedPrompt = prompt.toLowerCase();
  const repeatedFields = visualStateValues(contract.startState).filter(
    (value) => value.length >= 12 && normalizedPrompt.includes(value.toLowerCase()),
  );
  if (repeatedFields.length < 4) return [];
  return [issue(
    "redundant_image_prompt",
    "warning",
    "Image-guided prompt repeats too much static visual content instead of focusing on motion.",
  )];
}

export function formatNegativePrompt(
  provider: PromptTargetProvider,
  constraints: readonly string[],
): string {
  const unique = [...new Set(constraints.map((value) => value.trim()).filter(Boolean))];
  return provider === "google_veo"
    ? unique.join(", ")
    : `Avoid: ${unique.join(" | ")}`;
}

function compilerForMode(mode: GenerationMode): (contract: SceneContract) => string {
  return ({
    text_to_video: compileTextToVideoPrompt,
    first_frame: compileFirstFramePrompt,
    first_last_frame: compileFirstLastFramePrompt,
    reference_guided: compileReferenceGuidedPrompt,
  } as const)[mode];
}

function compileTextToVideoPrompt(contract: SceneContract): string {
  return [
    `Scene goal: ${contract.goal}`,
    `Subject: ${contract.startState.subjectState}`,
    `Product: ${contract.startState.productState}`,
    `Environment: ${contract.startState.environmentState}`,
    `Lighting: ${contract.startState.lightingState}`,
    `Visual style: ${contract.visualStyle}`,
    `Audio direction: ${contract.audioDirection}`,
    `Opening camera and composition: ${contract.startState.cameraState} ${contract.startState.compositionState}`,
    motionInstructions(contract),
    `Finish in this stable state for ${formatSeconds(contract.stableEndSeconds)} seconds: ${contract.endState.cameraState} ${contract.endState.compositionState}`,
  ].join("\n");
}

function compileFirstFramePrompt(contract: SceneContract): string {
  return [
    "Use the supplied first frame as the authoritative visual state; do not redescribe or restage it.",
    `Scene goal: ${contract.goal}`,
    motionInstructions(contract),
    "Visual style continuity: preserve the style established by the supplied first frame without redescribing or restaging it.",
    `Audio direction: ${contract.audioDirection}`,
    "Preserve the identity, product geometry, environment layout, and lighting direction visible in the first frame.",
    `Settle naturally and hold the final composition for ${formatSeconds(contract.stableEndSeconds)} seconds.`,
  ].join("\n");
}

function compileFirstLastFramePrompt(contract: SceneContract): string {
  const stateChanges = describeStateChanges(contract.startState, contract.endState);
  return [
    "Use the supplied first and last frames as authoritative boundary states.",
    `Scene goal: ${contract.goal}`,
    `Create one continuous transition driven by this action: ${contract.primaryAction}`,
    `Motion: ${contract.subjectMotion} Camera: ${contract.cameraMotion} Environment: ${contract.environmentMotion}`,
    "Visual style continuity: maintain the style shared by the supplied boundary frames.",
    `Audio direction: ${contract.audioDirection}`,
    `Required boundary changes: ${stateChanges}`,
    `Arrive at the supplied last frame smoothly and stabilize for ${formatSeconds(contract.stableEndSeconds)} seconds.`,
  ].join("\n");
}

function compileReferenceGuidedPrompt(contract: SceneContract): string {
  return [
    "Treat the bound reference inputs as the authority for identity, product truth, environment, and style.",
    `Scene goal: ${contract.goal}`,
    motionInstructions(contract),
    "Visual style continuity: preserve the bound visual direction without redescribing it.",
    `Audio direction: ${contract.audioDirection}`,
    "Preserve reference identity, product geometry, environment layout, lighting direction, and visual style without restating the reference content.",
    `Hold a stable ending for ${formatSeconds(contract.stableEndSeconds)} seconds.`,
  ].join("\n");
}

function motionInstructions(contract: SceneContract): string {
  return [
    `Primary action: ${contract.primaryAction}`,
    `Subject motion: ${contract.subjectMotion}`,
    `Camera motion: ${contract.cameraMotion}`,
    `Environment motion: ${contract.environmentMotion}`,
    `Background policy: ${contract.backgroundPolicy}.`,
  ].join(" ");
}

function compilerConfigFor(
  generationMode: GenerationMode,
  targetProvider: PromptTargetProvider,
): ScenePromptCompilerConfig {
  return {
    negativePromptFormat: targetProvider === "google_veo" ? "comma_separated" : "avoid_pipe",
    visualStylePolicy: generationMode === "text_to_video" ? "explicit" : "continuity",
    audioDirectionPolicy: "explicit",
  };
}

function describeStateChanges(
  startState: StructuredVisualState,
  endState: StructuredVisualState,
): string {
  const labels: Array<keyof StructuredVisualState> = [
    "subjectState",
    "productState",
    "environmentState",
    "lightingState",
    "cameraState",
    "compositionState",
  ];
  const changes = labels
    .filter((key) => startState[key] !== endState[key])
    .map((key) => `${key}: ${startState[key]} -> ${endState[key]}`);
  return changes.length > 0 ? changes.join("; ") : "Maintain the same locked visual state.";
}

function countSequentialActions(value: string): number {
  return value.match(/\b(?:then|and then|followed by|after that|sau đó|rồi|tiếp theo)\b/gi)?.length ?? 0;
}

function hasConflictingCameraInstructions(value: string): boolean {
  return [
    [/(?:pan|track|truck)\s+left/, /(?:pan|track|truck)\s+right/],
    [/(?:zoom|dolly)\s+in/, /(?:zoom|dolly)\s+out/],
    [/(?:rotate|rotation|orbit)\s+clockwise/, /(?:rotate|rotation|orbit)\s+counterclockwise/],
  ].some(([first, second]) => first.test(value) && second.test(value));
}

function hasEmptyVisualState(state: StructuredVisualState): boolean {
  return visualStateValues(state).some((value) => !value.trim());
}

function visualStateValues(state: StructuredVisualState): string[] {
  return [
    state.subjectState,
    state.productState,
    state.environmentState,
    state.lightingState,
    state.cameraState,
    state.compositionState,
  ];
}

function isGenericLock(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length < 12 || /(?:chưa khóa|không xác định|tbd|generic|mặc định)/.test(normalized);
}

function issue(
  code: PromptLintIssue["code"],
  severity: PromptLintIssue["severity"],
  message: string,
): PromptLintIssue {
  return { code, severity, message };
}

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "");
}
