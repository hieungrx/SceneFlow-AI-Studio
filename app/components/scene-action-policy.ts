import type { Scene } from "../../lib/types";

export type SceneActionPolicy = {
  canApprove: boolean;
  canReject: boolean;
  canGenerate: boolean;
  generationLabel: string;
  lockedReason: string | null;
};

export type PipelineActionPolicy =
  | { kind: "generate"; scene: Scene }
  | { kind: "wait_for_qc"; scene: Scene }
  | { kind: "wait_for_generation"; scene: Scene; reason: string }
  | { kind: "blocked"; scene: Scene; reason: string }
  | { kind: "complete" };

export function getSceneActionPolicy(
  scene: Scene,
  scenes: Scene[],
  hasActiveGeneration: boolean,
): SceneActionPolicy {
  const isReviewing = scene.status === "quality_check";
  const approvalReady = Boolean(scene.outputVideoUri && scene.endFrameUri);
  const dependencyApproved = !scene.dependsOnSceneId || scenes.some(
    (candidate) => candidate.id === scene.dependsOnSceneId && candidate.status === "approved",
  );
  const isActive = scene.status === "queued" || scene.status === "generating";
  const canGenerate = !hasActiveGeneration && !isReviewing && !isActive && dependencyApproved;

  return {
    canApprove: isReviewing && approvalReady,
    canReject: isReviewing,
    canGenerate,
    generationLabel: generationLabel(scene, dependencyApproved, hasActiveGeneration),
    lockedReason: lockedReason(scene, dependencyApproved, hasActiveGeneration, approvalReady),
  };
}

export function getPipelineActionPolicy(
  scenes: Scene[],
  hasActiveGeneration: boolean,
): PipelineActionPolicy {
  const scene = scenes.find((candidate) => candidate.status !== "approved");
  if (!scene) return { kind: "complete" };
  if (scene.status === "quality_check") return { kind: "wait_for_qc", scene };
  if (scene.status === "queued" || scene.status === "generating") {
    return {
      kind: "wait_for_generation",
      scene,
      reason: `Cảnh ${scene.sceneIndex} đang được tạo. Pipeline sẽ không gửi thêm cảnh.`,
    };
  }
  if (hasActiveGeneration) {
    return {
      kind: "wait_for_generation",
      scene,
      reason: "Dự án đang có một cảnh được tạo. Pipeline sẽ không gửi thêm cảnh.",
    };
  }

  const policy = getSceneActionPolicy(scene, scenes, hasActiveGeneration);
  if (!policy.canGenerate) {
    return {
      kind: "blocked",
      scene,
      reason: policy.lockedReason ?? "Cảnh chưa đủ điều kiện để tạo.",
    };
  }
  return { kind: "generate", scene };
}

function generationLabel(
  scene: Scene,
  dependencyApproved: boolean,
  hasActiveGeneration: boolean,
): string {
  if (scene.status === "queued" || scene.status === "generating") return "Đang tạo";
  if (scene.status === "quality_check") return "Chờ quyết định QC";
  if (!dependencyApproved) return "Chờ cảnh trước";
  if (hasActiveGeneration) return "Đang có cảnh chạy";
  return scene.status === "planned" || scene.status === "waiting_previous"
    ? "Tạo cảnh"
    : "Tạo lại";
}

function lockedReason(
  scene: Scene,
  dependencyApproved: boolean,
  hasActiveGeneration: boolean,
  approvalReady: boolean,
): string | null {
  if (scene.status === "quality_check") {
    return approvalReady ? null : "Video hoặc frame continuity chưa sẵn sàng để duyệt.";
  }
  if (!dependencyApproved) return "Cảnh trước phải được duyệt để mở khóa continuity.";
  if (scene.status === "queued" || scene.status === "generating") {
    return "Cảnh này đang được provider xử lý.";
  }
  if (hasActiveGeneration) return "Dự án đang có một cảnh được tạo.";
  return null;
}
