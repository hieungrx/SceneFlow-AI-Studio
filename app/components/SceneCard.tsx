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
  const activeJob = jobs.find((job) => job.sceneId === scene.id);

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
          <span className="visual-subject">{index === 3 ? "Khung hero dự kiến" : "Đã lập kế hoạch nhận dạng"}</span>
        ) : null}
        {scene.status === "queued" || scene.status === "generating" ? (
          <div className="generation-overlay">
            <span className="spinner" />
            <strong>{activeJob?.progress ?? 18}%</strong>
            <small>{activeJob ? modelLabel(activeJob.model) : "Đang chờ model đã chọn"}</small>
          </div>
        ) : null}
      </div>
      <div className="scene-content">
        <div className="scene-title-row">
          <h3>{scene.title}</h3>
          <StatusPill status={scene.status} />
        </div>
        <p className="scene-goal"><strong>Mục tiêu:</strong> {scene.sceneContract.goal}</p>
        <div className="scene-contract-grid">
          <div><strong>Hành động chính</strong><span>{scene.sceneContract.primaryAction}</span></div>
          <div><strong>Trạng thái đầu</strong><span>{scene.sceneContract.startState.compositionState}</span></div>
          <div><strong>Trạng thái cuối</strong><span>{scene.sceneContract.endState.compositionState}</span></div>
          <div><strong>Chế độ tạo</strong><span>{generationModeLabel(scene.sceneContract.generationMode)}</span></div>
          <div><strong>Phong cách</strong><span>{scene.sceneContract.visualStyle}</span></div>
          <div><strong>Âm thanh</strong><span>{scene.sceneContract.audioDirection}</span></div>
          <div><strong>Rủi ro</strong><span>{scene.sceneContract.riskFactors.length > 0 ? scene.sceneContract.riskFactors.join(", ") : "Không phát hiện rủi ro đặc thù"}</span></div>
        </div>
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

function generationModeLabel(mode: Scene["sceneContract"]["generationMode"]): string {
  return ({
    text_to_video: "Text-to-video",
    first_frame: "First-frame",
    first_last_frame: "First/last-frame",
    reference_guided: "Reference-guided",
  } as const)[mode];
}

function modelLabel(model: GenerationJob["model"]): string {
  return ({
    "veo-3.1-lite": "Veo 3.1 Lite",
    "veo-3.1-fast": "Veo 3.1 Fast",
    "veo-3.1-standard": "Veo 3.1 Standard",
  } as const)[model];
}
