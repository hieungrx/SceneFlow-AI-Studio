import type { GenerationJob, Scene } from "../../lib/types";
import { getSceneActionPolicy } from "./scene-action-policy";

type SceneCardProps = {
  scene: Scene;
  scenes: Scene[];
  jobs: GenerationJob[];
  index: number;
  busy: boolean;
  pendingAction: "approve" | "reject" | "generate" | null;
  hasActiveGeneration: boolean;
  mediaUrl: string | null;
  onShowPrompt: (scene: Scene) => void;
  onGenerate: (scene: Scene) => void;
  onApprove: (scene: Scene) => void;
  onReject: (scene: Scene) => void;
};

export default function SceneCard({
  scene,
  scenes,
  jobs,
  index,
  busy,
  pendingAction,
  hasActiveGeneration,
  mediaUrl,
  onShowPrompt,
  onGenerate,
  onApprove,
  onReject,
}: SceneCardProps) {
  const policy = getSceneActionPolicy(scene, scenes, hasActiveGeneration);
  const actionPending = pendingAction !== null;
  const actionDisabled = busy || actionPending;

  return (
    <article className="scene-card">
      <div className={`scene-visual tone-${["one", "two", "three", "four"][index % 4]}${mediaUrl ? " has-preview" : ""}`}>
        {mediaUrl ? (
          <video
            aria-label={`Video cảnh ${scene.sceneIndex}`}
            className="scene-preview"
            controls
            preload="metadata"
            src={mediaUrl}
          >
            Trình duyệt không hỗ trợ xem video.
          </video>
        ) : null}
        <span className="scene-number">{String(scene.sceneIndex).padStart(2, "0")}</span>
        <span className="duration-pill">{scene.durationSeconds}s</span>
        {!mediaUrl ? (
          <span className="visual-subject">{index === 3 ? "Hero frame" : "Identity locked"}</span>
        ) : null}
        {scene.status === "queued" || scene.status === "generating" ? (
          <div className="generation-overlay">
            <span className="spinner" />
            <strong>{jobProgress(jobs, scene.id)}%</strong>
            <small>Veo Lower Priority</small>
          </div>
        ) : null}
      </div>
      <div className="scene-content">
        <div className="scene-title-row">
          <h3>{scene.title}</h3>
          <StatusPill status={scene.status} />
        </div>
        <p>{scene.action}</p>
        <div className="boundary-note"><strong>Kết cảnh:</strong> {scene.endState}</div>
        {scene.status === "quality_check" ? (
          <div className="qc-actions" aria-label={`Quyết định QC cảnh ${scene.sceneIndex}`}>
            <button
              className="qc-approve-button"
              type="button"
              disabled={actionDisabled || !policy.canApprove}
              onClick={() => onApprove(scene)}
            >
              {pendingAction === "approve" ? "Đang duyệt…" : "Duyệt cảnh"}
            </button>
            <button
              className="qc-reject-button"
              type="button"
              disabled={actionDisabled || !policy.canReject}
              onClick={() => onReject(scene)}
            >
              {pendingAction === "reject" ? "Đang từ chối…" : "Từ chối"}
            </button>
          </div>
        ) : (
          <div className="scene-actions">
            <button type="button" onClick={() => onShowPrompt(scene)}>Xem prompt</button>
            <button
              type="button"
              disabled={actionDisabled || !policy.canGenerate}
              onClick={() => onGenerate(scene)}
            >
              {pendingAction === "generate" ? "Đang gửi…" : policy.generationLabel}
            </button>
          </div>
        )}
        {policy.lockedReason ? (
          <small className="scene-action-hint">{policy.lockedReason}</small>
        ) : null}
      </div>
    </article>
  );
}

function StatusPill({ status }: { status: Scene["status"] }) {
  const css = status === "approved"
    ? "completed"
    : status === "generating"
      ? "processing"
      : status === "waiting_previous" || status === "planned"
        ? "draft"
        : status === "rejected"
          ? "failed"
          : status;
  return <span className={`status-pill status-${css}`}>{sceneStatusLabel(status)}</span>;
}

function sceneStatusLabel(status: Scene["status"]): string {
  return ({
    approved: "Đã duyệt",
    rejected: "Đã từ chối",
    generating: "Đang tạo",
    queued: "Đã xếp hàng",
    waiting_previous: "Chờ cảnh trước",
    planned: "Đã lên kế hoạch",
    quality_check: "Đang QC",
    failed: "Lỗi",
  } as Record<Scene["status"], string>)[status];
}

function jobProgress(jobs: GenerationJob[], sceneId: string): number {
  return jobs.find((job) => job.sceneId === sceneId)?.progress ?? 18;
}
