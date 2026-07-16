import type { Scene, SceneStatus } from "./types";

export type QcDecision = "approve" | "reject";

export type QcRequest = {
  decision: QcDecision;
  reason?: string;
};

export type SceneTransitionError =
  | "invalid_scene_transition"
  | "scene_media_not_ready";

export type SceneTransitionResult =
  | { ok: true; patch: Partial<Scene> }
  | { ok: false; error: SceneTransitionError };

export type GenerationTransitionInput =
  | { kind: "running" }
  | { kind: "failed"; outputVideoUri?: string | null }
  | {
      kind: "completed";
      outputVideoUri: string | null;
      endFrameUri: string | null;
    };

export const END_FRAME_EXTRACTION_FAILED = "end_frame_extraction_failed";

export function isActiveGenerationStatus(status: SceneStatus): boolean {
  return status === "queued" || status === "generating";
}

export function canRegenerateScene(status: SceneStatus): boolean {
  return status === "approved" || status === "rejected" || status === "failed";
}

export function generationSceneTransition(
  scene: Scene,
  input: GenerationTransitionInput,
): Partial<Scene> | null {
  if (!isActiveGenerationStatus(scene.status)) return null;

  if (input.kind === "running") {
    return { status: "generating" };
  }

  if (input.kind === "failed") {
    return {
      status: "failed",
      ...(input.outputVideoUri ? { outputVideoUri: input.outputVideoUri } : {}),
    };
  }

  if (!input.outputVideoUri || !input.endFrameUri) {
    return {
      status: "failed",
      ...(input.outputVideoUri ? { outputVideoUri: input.outputVideoUri } : {}),
    };
  }

  return {
    status: "quality_check",
    outputVideoUri: input.outputVideoUri,
    endFrameUri: input.endFrameUri,
  };
}

export function endFrameExtractionFailure(
  scene: Scene,
  outputVideoUri: string,
): {
  errorCode: typeof END_FRAME_EXTRACTION_FAILED;
  scenePatch: Partial<Scene> | null;
} {
  const scenePatch = generationSceneTransition(scene, {
    kind: "failed",
    outputVideoUri,
  });
  return {
    errorCode: END_FRAME_EXTRACTION_FAILED,
    scenePatch: scenePatch ? { ...scenePatch, endFrameUri: null } : null,
  };
}

export function qcSceneTransition(
  scene: Scene,
  decision: QcDecision,
): SceneTransitionResult {
  if (scene.status !== "quality_check") {
    return { ok: false, error: "invalid_scene_transition" };
  }
  if (decision === "approve" && (!scene.outputVideoUri || !scene.endFrameUri)) {
    return { ok: false, error: "scene_media_not_ready" };
  }
  return {
    ok: true,
    patch: { status: decision === "approve" ? "approved" : "rejected" },
  };
}

export function parseQcRequest(value: unknown): QcRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.decision !== "approve" && body.decision !== "reject") return null;
  if (body.reason === undefined) return { decision: body.decision };
  if (body.decision !== "reject" || typeof body.reason !== "string") return null;
  const reason = body.reason.trim();
  if ([...reason].length > 500) return null;
  return reason ? { decision: body.decision, reason } : { decision: body.decision };
}
