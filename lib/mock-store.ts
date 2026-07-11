import { demoJobs, demoProject, demoScenes } from "./mock-data";
import type { FinalRender, GenerationJob, Project, Scene } from "./types";

const projects = new Map<string, Project>([[demoProject.id, demoProject]]);
const scenes = new Map<string, Scene>(demoScenes.map((scene) => [scene.id, scene]));
const jobs = new Map<string, GenerationJob>(demoJobs.map((job) => [job.id, job]));
const renders = new Map<string, FinalRender>();

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

export function saveJob(job: GenerationJob): GenerationJob {
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): GenerationJob | null {
  return jobs.get(id) ?? null;
}

export function updateJob(id: string, patch: Partial<GenerationJob>): GenerationJob | null {
  const job = jobs.get(id);
  if (!job) return null;
  const updated = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(id, updated);
  return updated;
}

export function findActiveJobForScene(sceneId: string): GenerationJob | null {
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

export function updateRender(id: string, patch: Partial<FinalRender>): FinalRender | null {
  const render = renders.get(id);
  if (!render) return null;
  const updated = { ...render, ...patch, updatedAt: new Date().toISOString() };
  renders.set(id, updated);
  return updated;
}
