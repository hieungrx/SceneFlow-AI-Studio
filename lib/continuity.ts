import type { Scene, StoryBible } from "./types";

export type ContinuityIssue = {
  code: "missing_boundary" | "dependency_mismatch" | "missing_lock" | "unstable_end";
  severity: "warning" | "error";
  message: string;
};

export function validateStoryBible(bible: StoryBible): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  if (!bible.characterLock.trim()) {
    issues.push({ code: "missing_lock", severity: "warning", message: "Chưa khóa mô tả nhân vật." });
  }
  if (!bible.productLock.trim()) {
    issues.push({ code: "missing_lock", severity: "error", message: "Chưa khóa hình dáng sản phẩm." });
  }
  if (!bible.lightingLock.trim()) {
    issues.push({ code: "missing_lock", severity: "warning", message: "Chưa khóa hướng ánh sáng." });
  }
  return issues;
}

export function validateSceneChain(sceneList: Scene[]): ContinuityIssue[] {
  const ordered = [...sceneList].sort((a, b) => a.sceneIndex - b.sceneIndex);
  const issues: ContinuityIssue[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const scene = ordered[index];
    const previous = ordered[index - 1];
    if (index > 0 && scene.dependsOnSceneId !== previous.id) {
      issues.push({
        code: "dependency_mismatch",
        severity: "error",
        message: `Cảnh ${scene.sceneIndex} chưa phụ thuộc đúng cảnh ${previous.sceneIndex}.`,
      });
    }
    if (!scene.startState.trim() || !scene.endState.trim()) {
      issues.push({
        code: "missing_boundary",
        severity: "error",
        message: `Cảnh ${scene.sceneIndex} thiếu trạng thái đầu hoặc cuối.`,
      });
    }
    if (scene.transition === "seamless" && index > 0 && !scene.startFrameUri) {
      issues.push({
        code: "unstable_end",
        severity: "warning",
        message: `Cảnh ${scene.sceneIndex} cần frame đầu để nối liền mạch.`,
      });
    }
  }
  return issues;
}
