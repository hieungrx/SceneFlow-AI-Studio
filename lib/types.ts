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
