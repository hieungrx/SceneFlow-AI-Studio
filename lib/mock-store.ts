import { demoJobs, demoProject, demoScenes } from "./mock-data";
import type {
  ExtractionClaimKind,
  FinalRender,
  GenerationJob,
  GenerationJobProcessingState,
  Project,
  Scene,
} from "./types";

const projects = new Map<string, Project>([[demoProject.id, demoProject]]);
const scenes = new Map<string, Scene>(demoScenes.map((scene) => [scene.id, scene]));
const jobs = new Map<string, GenerationJobProcessingState>(
  demoJobs.map((job) => [job.id, processingStateFromJob(job)]),
);
const renders = new Map<string, FinalRender>();
const EXTRACTION_CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function listProjects(ownerId?: string): Project[] {
  return [...projects.values()]
    .filter((project) => !ownerId || project.ownerId === ownerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string, ownerId?: string): Project | null {
  const project = projects.get(id) ?? null;
  if (!project || (ownerId && project.ownerId !== ownerId)) return null;
  return project;
}

export function getProjectScenes(projectId: string): Scene[] {
  return [...scenes.values()]
    .filter((scene) => scene.projectId === projectId)
    .sort((a, b) => a.sceneIndex - b.sceneIndex);
}

export function getScene(id: string): Scene | null {
  return scenes.get(id) ?? null;
}

export function updateScene(id: string, patch: Partial<Scene>): Scene | null {
  const scene = scenes.get(id);
  if (!scene) return null;
  const updated = { ...scene, ...patch };
  scenes.set(id, updated);
  return updated;
}

export function transitionSceneFromStatus(
  id: string,
  expectedStatus: Scene["status"],
  patch: Partial<Scene>,
): Scene | null {
  const scene = scenes.get(id);
  if (!scene || scene.status !== expectedStatus) return null;
  return updateScene(id, patch);
}

export function transitionSceneFromStatusForJobClaim(
  sceneId: string,
  expectedStatus: Scene["status"],
  jobId: string,
  expectedClaimToken: string,
  expectedClaimKind: ExtractionClaimKind,
  patch: Partial<Scene>,
): Scene | null {
  const scene = scenes.get(sceneId);
  const job = jobs.get(jobId);
  if (
    !scene ||
    scene.status !== expectedStatus ||
    !job ||
    job.sceneId !== sceneId ||
    job.projectId !== scene.projectId ||
    (job.status !== "queued" && job.status !== "running") ||
    job.extractionClaimToken !== expectedClaimToken ||
    job.extractionClaimKind !== expectedClaimKind ||
    (expectedClaimKind === "completion"
      ? job.extractionFailureCode !== null
      : job.extractionFailureCode !== "end_frame_extraction_failed")
  ) {
    return null;
  }
  return updateScene(sceneId, patch);
}

export function createProject(
  input: Pick<Project, "name" | "brief" | "template" | "aspectRatio" | "targetDurationSeconds" | "model">,
  ownerId = "demo-user",
): Project {
  const createdAt = new Date().toISOString();
  const project: Project = {
    id: `prj_${crypto.randomUUID()}`,
    ownerId,
    ...input,
    status: "draft",
    storyBible: {
      characterLock: "Chưa khóa nhân vật",
      productLock: "Giữ đúng thiết kế, màu sắc và tỷ lệ sản phẩm từ ảnh tải lên.",
      environmentLock: "Dùng cùng một bối cảnh trong các cảnh liên tục.",
      lightingLock: "Giữ nguyên hướng sáng giữa các cảnh.",
      visualStyle: "Photorealistic cinematic commercial.",
      audioDirection: "Voice-over và nhạc nền được trộn trên timeline chung.",
      mustAvoid: ["product deformation", "identity drift", "unreadable text"],
    },
    createdAt,
    updatedAt: createdAt,
  };
  projects.set(project.id, project);
  return project;
}

export function saveScenes(projectId: string, nextScenes: Scene[]): Scene[] {
  for (const scene of nextScenes) scenes.set(scene.id, { ...scene, projectId });
  const project = projects.get(projectId);
  if (project) projects.set(projectId, { ...project, status: "planning", updatedAt: new Date().toISOString() });
  return getProjectScenes(projectId);
}

export function saveJob(job: GenerationJob): GenerationJobProcessingState {
  const processingState = processingStateFromJob(job);
  jobs.set(job.id, processingState);
  return processingState;
}

export function getJob(id: string): GenerationJobProcessingState | null {
  return jobs.get(id) ?? null;
}

export function updateJob(
  id: string,
  patch: Partial<GenerationJobProcessingState>,
): GenerationJobProcessingState | null {
  const job = jobs.get(id);
  if (!job) return null;
  const updated: GenerationJobProcessingState = {
    ...job,
    ...patch,
    stateVersion: job.stateVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, updated);
  return updated;
}

export function transitionJobFromSnapshot(
  id: string,
  expected: Pick<GenerationJobProcessingState, "status" | "stateVersion">,
  patch: Partial<GenerationJobProcessingState>,
): GenerationJobProcessingState | null {
  if (
    patch.extractionClaimToken !== undefined &&
    patch.extractionClaimToken !== null &&
    !EXTRACTION_CLAIM_TOKEN_PATTERN.test(patch.extractionClaimToken)
  ) {
    return null;
  }
  const job = jobs.get(id);
  if (
    !job ||
    job.status !== expected.status ||
    job.stateVersion !== expected.stateVersion
  ) {
    return null;
  }
  return updateJob(id, patch);
}

export function findActiveJobForScene(sceneId: string): GenerationJobProcessingState | null {
  return [...jobs.values()].find(
    (job) => job.sceneId === sceneId && (job.status === "queued" || job.status === "running"),
  ) ?? null;
}

export function saveRender(render: FinalRender): FinalRender {
  renders.set(render.id, render);
  return render;
}

export function getRender(id: string): FinalRender | null {
  return renders.get(id) ?? null;
}

export function findActiveRenderForProject(projectId: string): FinalRender | null {
  return [...renders.values()]
    .filter(
      (render) =>
        render.projectId === projectId &&
        (render.status === "queued" || render.status === "running"),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function updateRender(id: string, patch: Partial<FinalRender>): FinalRender | null {
  const render = renders.get(id);
  if (!render) return null;
  const updated = { ...render, ...patch, updatedAt: new Date().toISOString() };
  renders.set(id, updated);
  return updated;
}

function processingStateFromJob(job: GenerationJob): GenerationJobProcessingState {
  const processingState = job as Partial<GenerationJobProcessingState>;
  return {
    ...job,
    extractionClaimToken: processingState.extractionClaimToken ?? null,
    extractionClaimKind: processingState.extractionClaimKind ?? null,
    extractionClaimExpiresAt: processingState.extractionClaimExpiresAt ?? null,
    extractionFailureCode: processingState.extractionFailureCode ?? null,
    stateVersion: processingState.stateVersion ?? 0,
  };
}
