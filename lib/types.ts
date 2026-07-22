export type AspectRatio = "9:16" | "16:9";
export type VideoModel = "veo-3.1-lite" | "veo-3.1-fast" | "veo-3.1-standard";
export type ProjectStatus =
  | "draft"
  | "planning"
  | "generating"
  | "review"
  | "rendering"
  | "completed"
  | "failed";
export type SceneStatus =
  | "planned"
  | "waiting_previous"
  | "queued"
  | "generating"
  | "quality_check"
  | "approved"
  | "rejected"
  | "failed";
export type JobStatus = "queued" | "running" | "done" | "failed" | "canceled";

export type StoryBible = {
  characterLock: string;
  productLock: string;
  environmentLock: string;
  lightingLock: string;
  visualStyle: string;
  audioDirection: string;
  mustAvoid: string[];
};

export type GenerationMode =
  | "text_to_video"
  | "first_frame"
  | "first_last_frame"
  | "reference_guided";

export type BackgroundPolicy = "static" | "controlled_motion";

export type StructuredVisualState = {
  subjectState: string;
  productState: string;
  environmentState: string;
  lightingState: string;
  cameraState: string;
  compositionState: string;
};

export type SceneContract = {
  version: number;
  sceneId: string;
  sceneIndex: number;
  goal: string;
  startState: StructuredVisualState;
  endState: StructuredVisualState;
  primaryAction: string;
  subjectMotion: string;
  cameraMotion: string;
  environmentMotion: string;
  backgroundPolicy: BackgroundPolicy;
  continuityLocks: string[];
  negativeConstraints: string[];
  generationMode: GenerationMode;
  riskFactors: string[];
  stableEndSeconds: number;
};

export type PromptLintSeverity = "error" | "warning";

export type PromptLintIssueCode =
  | "multiple_primary_actions"
  | "conflicting_camera_instructions"
  | "locked_camera_motion_conflict"
  | "missing_stable_end_state"
  | "excessive_sequential_actions"
  | "missing_continuity_locks"
  | "redundant_image_prompt"
  | "generic_story_bible_lock";

export type PromptLintIssue = {
  code: PromptLintIssueCode;
  severity: PromptLintSeverity;
  message: string;
};

export type ScenePromptCompilation = {
  compilerVersion: string;
  deterministic: true;
  generationMode: GenerationMode;
  prompt: string;
  negativePrompt: string;
  lintIssues: PromptLintIssue[];
};

export type StoryboardCompilation = {
  schemaVersion: 1;
  planner: {
    kind: "deterministic_rules";
    version: string;
  };
  storyBible: StoryBible;
  sceneContracts: SceneContract[];
};

export type StoryboardVersion = {
  id: string;
  projectId: string;
  version: number;
  status: "active" | "superseded" | "approved";
  sourcePrompt: string;
  compiled: StoryboardCompilation;
  createdAt: string;
};

export type PromptVersion = {
  id: string;
  projectId: string;
  sceneId: string | null;
  version: number;
  rawPrompt: string;
  optimizedPrompt: string;
  assumptions: string[];
  compilerVersion: string;
  generationMode: GenerationMode;
  lintIssues: PromptLintIssue[];
  accepted: boolean;
  createdAt: string;
};

export type StoryboardVersionDraft = {
  id: string;
  sourcePrompt: string;
  compiled: StoryboardCompilation;
  scenes: Scene[];
  promptVersions: PromptVersion[];
  allowApprovedReplacement: boolean;
};

export type Project = {
  id: string;
  ownerId: string;
  name: string;
  brief: string;
  template: string;
  aspectRatio: AspectRatio;
  targetDurationSeconds: number;
  model: VideoModel;
  status: ProjectStatus;
  storyBible: StoryBible;
  createdAt: string;
  updatedAt: string;
};

export type Scene = {
  id: string;
  projectId: string;
  storyboardId: string | null;
  storyboardVersion: number | null;
  sceneContract: SceneContract;
  promptVersionId: string | null;
  promptVersion: number | null;
  promptCompilerVersion: string | null;
  sceneIndex: number;
  title: string;
  durationSeconds: number;
  status: SceneStatus;
  startState: string;
  action: string;
  endState: string;
  prompt: string;
  negativePrompt: string;
  transition: "hard_cut" | "match_cut" | "crossfade" | "seamless";
  dependsOnSceneId: string | null;
  startFrameUri: string | null;
  endFrameUri: string | null;
  outputVideoUri: string | null;
  qualityScore: number | null;
};

export type GenerationJob = {
  id: string;
  projectId: string;
  sceneId: string;
  provider: "mock" | "google";
  providerOperationId: string | null;
  model: VideoModel;
  status: JobStatus;
  progress: number;
  attempt: number;
  estimatedCostUsd: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExtractionClaimKind = "completion" | "failure";

export type ExtractionFailureCode = "end_frame_extraction_failed";

export type GenerationJobProcessingState = GenerationJob & {
  extractionClaimToken: string | null;
  extractionClaimKind: ExtractionClaimKind | null;
  extractionClaimExpiresAt: string | null;
  extractionFailureCode: ExtractionFailureCode | null;
  stateVersion: number;
};

export type AssetKind = "product" | "character" | "environment" | "keyframe" | "audio";

export type AssetRecord = {
  id: string;
  projectId: string;
  ownerId: string;
  kind: AssetKind;
  r2Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
};

export type PromptCompilation = {
  intent: string;
  lockedFields: string[];
  assumptions: string[];
  clarificationQuestions: string[];
  optimizedPromptEn: string;
  negativePrompt: string;
  compiler: {
    kind: "deterministic_rules";
    version: string;
    label: string;
  };
  config: {
    aspectRatio: AspectRatio;
    durationSeconds: 4 | 6 | 8;
    model: VideoModel;
  };
};

export type RenderScene = {
  sceneId: string;
  sceneIndex: number;
  sourceUri: string;
  trimInSeconds: number;
  trimOutSeconds: number;
  transition: Scene["transition"];
  transitionDurationSeconds: number;
  timelineStartSeconds: number;
};

export type RenderManifest = {
  projectId: string;
  targetDurationSeconds: number;
  output: {
    width: number;
    height: number;
    fps: 24;
    videoCodec: "h264";
    audioSampleRate: 48000;
  };
  scenes: RenderScene[];
  voiceoverUri: string | null;
  musicUri: string | null;
  subtitlesUri: string | null;
  calculatedDurationSeconds: number;
};

export type FinalRender = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "done" | "failed";
  manifest: RenderManifest;
  outputVideoUri: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
};
