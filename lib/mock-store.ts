import { demoJobs, demoProject, demoScenes } from "./mock-data";
import type {
  ExtractionClaimKind,
  FinalRender,
  GenerationJob,
  GenerationJobProcessingState,
  Project,
  Scene,
} from "./types";
import type {
  GenerationActivationInput,
  GenerationFailureInput,
  GenerationReservationInput,
  GenerationReservationResult,
} from "./generation-start";
import type { FinalRenderReservationResult } from "./repository";

const projects = new Map<string, Project>([[demoProject.id, demoProject]]);
const scenes = new Map<string, Scene>(demoScenes.map((scene) => [scene.id, scene]));
const jobs = new Map<string, GenerationJobProcessingState>(
  demoJobs.map((job) => [job.id, processingStateFromJob(job)]),
);
const renders = new Map<string, FinalRender>();
const creditBalances = new Map<string, number>();
const generationCharges = new Map<string, { ownerId: string; amount: number }>();
const generationRefunds = new Set<string>();
const EXTRACTION_CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function ensureUser(ownerId: string): void {
  if (!creditBalances.has(ownerId)) creditBalances.set(ownerId, 100);
}

export function getCreditBalance(ownerId: string): number {
  ensureUser(ownerId);
  return creditBalances.get(ownerId) ?? 0;
}

export function chargeCredits(ownerId: string, jobId: string, amount: number): number | null {
  ensureUser(ownerId);
  const existing = generationCharges.get(jobId);
  if (existing) return creditBalances.get(ownerId) ?? null;
  const balance = creditBalances.get(ownerId) ?? 0;
  if (balance < amount) return null;
  const balanceAfter = Math.round((balance - amount) * 100) / 100;
  creditBalances.set(ownerId, balanceAfter);
  generationCharges.set(jobId, { ownerId, amount });
  return balanceAfter;
}

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

export function findActiveJobForProject(projectId: string): GenerationJobProcessingState | null {
  return [...jobs.values()]
    .filter(
      (job) =>
        job.projectId === projectId &&
        (job.status === "queued" || job.status === "running"),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function reserveGeneration(
  ownerId: string,
  input: GenerationReservationInput,
): GenerationReservationResult {
  const scene = scenes.get(input.sceneId);
  if (!scene) return { kind: "blocked", error: "scene_not_found" };
  const project = projects.get(scene.projectId);
  if (!project || project.ownerId !== ownerId) {
    return { kind: "blocked", error: "scene_not_found" };
  }
  const activeJob = [...jobs.values()]
    .filter(
      (job) =>
        job.projectId === project.id &&
        (job.status === "queued" || job.status === "running"),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (activeJob) {
    return activeJob.sceneId === scene.id
      ? { kind: "reused", job: activeJob, project, scene: resolveSubmissionScene(scene) }
      : { kind: "blocked", error: "project_generation_in_progress", job: activeJob };
  }
  if (findActiveRenderForProject(project.id)) {
    return { kind: "blocked", error: "project_render_in_progress" };
  }
  if (scene.status === "quality_check") {
    return { kind: "blocked", error: "scene_requires_qc_decision" };
  }
  if (scene.status === "queued" || scene.status === "generating") {
    return { kind: "blocked", error: "scene_generation_inconsistent" };
  }
  if (!isGenerationAdmissionStatus(scene.status)) {
    return { kind: "blocked", error: "invalid_scene_generation_status" };
  }
  if (scene.dependsOnSceneId) {
    const previous = scenes.get(scene.dependsOnSceneId);
    if (
      !previous ||
      previous.projectId !== scene.projectId ||
      previous.status !== "approved" ||
      !previous.endFrameUri
    ) {
      return { kind: "blocked", error: "previous_scene_not_approved" };
    }
  }
  const balance = getCreditBalance(ownerId);
  if (balance < input.requiredCredits) {
    return {
      kind: "blocked",
      error: "insufficient_credits",
      requiredCredits: input.requiredCredits,
      balance,
    };
  }

  const attempt = [...jobs.values()]
    .filter((job) => job.sceneId === scene.id)
    .reduce((maximum, job) => Math.max(maximum, job.attempt), 0) + 1;
  const job: GenerationJobProcessingState = {
    id: input.jobId,
    projectId: project.id,
    sceneId: scene.id,
    provider: input.provider,
    providerOperationId: null,
    model: project.model,
    status: "queued",
    progress: 0,
    attempt,
    estimatedCostUsd: input.estimatedCostUsd,
    errorCode: null,
    extractionClaimToken: null,
    extractionClaimKind: null,
    extractionClaimExpiresAt: null,
    extractionFailureCode: null,
    stateVersion: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  jobs.set(job.id, job);
  const balanceAfter = chargeCredits(ownerId, job.id, input.requiredCredits);
  if (balanceAfter === null) {
    jobs.delete(job.id);
    return {
      kind: "blocked",
      error: "insufficient_credits",
      requiredCredits: input.requiredCredits,
      balance,
    };
  }
  return {
    kind: "reserved",
    job,
    project,
    scene: resolveSubmissionScene(scene),
    balanceAfter,
  };
}

export function activateGeneration(
  ownerId: string,
  input: GenerationActivationInput,
): GenerationJobProcessingState | null {
  const job = jobs.get(input.jobId);
  if (
    !job ||
    job.status !== "running" ||
    job.stateVersion !== input.expectedStateVersion ||
    job.providerOperationId !== null
  ) {
    return null;
  }
  const project = projects.get(job.projectId);
  const scene = scenes.get(job.sceneId);
  if (
    !project ||
    project.ownerId !== ownerId ||
    !scene ||
    scene.status !== input.expectedSceneStatus ||
    !isGenerationAdmissionStatus(scene.status)
  ) {
    return null;
  }
  let startFrameUri = scene.startFrameUri;
  if (scene.dependsOnSceneId) {
    const previous = scenes.get(scene.dependsOnSceneId);
    if (
      !previous ||
      previous.projectId !== scene.projectId ||
      previous.status !== "approved" ||
      !previous.endFrameUri
    ) {
      return null;
    }
    startFrameUri = previous.endFrameUri;
  }

  const activated = updateJob(job.id, {
    providerOperationId: input.operation.operationId,
    status: input.operation.status,
    progress: input.operation.progress,
    errorCode: null,
  });
  if (!activated) return null;
  updateScene(scene.id, {
    status: "queued",
    startFrameUri,
    endFrameUri: null,
    outputVideoUri: null,
    qualityScore: null,
  });
  if (scene.status === "approved" || scene.status === "rejected" || scene.status === "failed") {
    for (const downstream of getProjectScenes(scene.projectId)) {
      if (downstream.sceneIndex <= scene.sceneIndex) continue;
      updateScene(downstream.id, {
        status: "waiting_previous",
        startFrameUri: null,
        endFrameUri: null,
        outputVideoUri: null,
        qualityScore: null,
      });
    }
  }
  return activated;
}

export function failGenerationSubmissionAndRefund(
  ownerId: string,
  input: GenerationFailureInput,
): { job: GenerationJobProcessingState; balanceAfter: number } | null {
  const job = jobs.get(input.jobId);
  const project = job ? projects.get(job.projectId) : null;
  if (
    !job ||
    !project ||
    project.ownerId !== ownerId ||
    job.status !== "running" ||
    job.stateVersion !== input.expectedStateVersion ||
    job.providerOperationId !== null
  ) {
    return null;
  }
  const failed = updateJob(job.id, { status: "failed", progress: 0, errorCode: input.errorCode });
  if (!failed) return null;
  const charge = generationCharges.get(job.id);
  if (charge && charge.ownerId === ownerId && !generationRefunds.has(job.id)) {
    const balance = getCreditBalance(ownerId);
    creditBalances.set(ownerId, Math.round((balance + charge.amount) * 100) / 100);
    generationRefunds.add(job.id);
  }
  return { job: failed, balanceAfter: getCreditBalance(ownerId) };
}

export function saveRender(render: FinalRender): FinalRender {
  renders.set(render.id, render);
  return render;
}

export function reserveRender(
  ownerId: string,
  render: FinalRender,
): FinalRenderReservationResult {
  const project = projects.get(render.projectId);
  if (!project || project.ownerId !== ownerId) {
    return { kind: "blocked", error: "project_not_found" };
  }
  const activeJob = [...jobs.values()].find(
    (job) =>
      job.projectId === render.projectId &&
      (job.status === "queued" || job.status === "running"),
  );
  if (activeJob) return { kind: "blocked", error: "generation_in_progress" };
  const activeRender = findActiveRenderForProject(render.projectId);
  if (activeRender) return { kind: "reused", render: activeRender };
  const completedRender = [...renders.values()]
    .filter(
      (candidate) =>
        candidate.projectId === render.projectId &&
        candidate.status === "done" &&
        JSON.stringify(candidate.manifest) === JSON.stringify(render.manifest),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (completedRender) return { kind: "reused", render: completedRender };
  const projectScenes = getProjectScenes(render.projectId);
  if (
    projectScenes.length !== render.manifest.scenes.length ||
    render.manifest.scenes.some((manifestScene) => {
      const scene = scenes.get(manifestScene.sceneId);
      return !scene ||
        scene.projectId !== render.projectId ||
        scene.status !== "approved" ||
        scene.outputVideoUri !== manifestScene.sourceUri;
    })
  ) {
    return { kind: "blocked", error: "scenes_not_ready" };
  }
  renders.set(render.id, render);
  return { kind: "reserved", render };
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

function isGenerationAdmissionStatus(status: Scene["status"]): boolean {
  return status === "planned" ||
    status === "waiting_previous" ||
    status === "approved" ||
    status === "rejected" ||
    status === "failed";
}

function resolveSubmissionScene(scene: Scene): Scene {
  if (!scene.dependsOnSceneId) return scene;
  const previous = scenes.get(scene.dependsOnSceneId);
  return previous?.endFrameUri ? { ...scene, startFrameUri: previous.endFrameUri } : scene;
}
