import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { ensureDatabaseSchema } from "../db/bootstrap";
import {
  assets as assetsTable,
  creditLedger as creditLedgerTable,
  finalRenders as finalRendersTable,
  generationJobs as generationJobsTable,
  projects as projectsTable,
  scenes as scenesTable,
  users as usersTable,
} from "../db/schema";
import * as memory from "./mock-store";
import type { AssetRecord, FinalRender, GenerationJob, Project, Scene, StoryBible } from "./types";

type Db = ReturnType<typeof getDb>;
type ProjectInput = Pick<
  Project,
  "name" | "brief" | "template" | "aspectRatio" | "targetDurationSeconds" | "model"
>;

const DEFAULT_STORY_BIBLE: StoryBible = {
  characterLock: "Giữ nguyên khuôn mặt, tóc, vóc dáng và trang phục từ ảnh tham chiếu.",
  productLock: "Giữ đúng thiết kế, màu sắc, nhãn và tỷ lệ sản phẩm.",
  environmentLock: "Dùng cùng một không gian trong các cảnh liên tục.",
  lightingLock: "Giữ nguyên hướng sáng, nhiệt độ màu và thời điểm trong ngày.",
  visualStyle: "Photorealistic cinematic commercial, natural motion, realistic textures.",
  audioDirection: "Một nền âm thanh xuyên suốt; lời thoại chỉ xuất hiện khi người dùng yêu cầu.",
  mustAvoid: ["identity drift", "product deformation", "duplicated objects", "unreadable text"],
};

async function withMemoryFallback<T>(
  primary: (db: Db) => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  try {
    await ensureDatabaseSchema();
    return await primary(getDb());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/binding `DB` is unavailable|No such module "cloudflare:workers"/i.test(message)) throw error;
    return fallback();
  }
}

export async function ensureUser(ownerId: string, displayName: string): Promise<void> {
  const now = new Date().toISOString();
  await withMemoryFallback(
    async (db) => {
      await db
        .insert(usersTable)
        .values({ id: ownerId, email: ownerId, displayName, createdAt: now })
        .onConflictDoUpdate({
          target: usersTable.email,
          set: { displayName },
        });
      const [ledger] = await db
        .select({ id: creditLedgerTable.id })
        .from(creditLedgerTable)
        .where(eq(creditLedgerTable.ownerId, ownerId))
        .limit(1);
      if (!ledger) {
        await db.insert(creditLedgerTable).values({
          id: `credit_welcome_${crypto.randomUUID()}`,
          ownerId,
          projectId: null,
          jobId: null,
          kind: "welcome_grant",
          amountCredits: 100,
          balanceAfter: 100,
          note: "Creator trial",
          createdAt: now,
        });
      }
    },
    () => undefined,
  );
}

export async function listOwnedProjects(ownerId: string): Promise<Project[]> {
  return withMemoryFallback(
    async (db) => {
      const rows = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.ownerId, ownerId))
        .orderBy(desc(projectsTable.updatedAt));
      return rows.map(projectFromRow);
    },
    () => memory.listProjects(ownerId),
  );
}

export async function getOwnedProject(ownerId: string, id: string): Promise<Project | null> {
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(projectsTable)
        .where(and(eq(projectsTable.id, id), eq(projectsTable.ownerId, ownerId)))
        .limit(1);
      return row ? projectFromRow(row) : null;
    },
    () => memory.getProject(id, ownerId),
  );
}

export async function createOwnedProject(ownerId: string, input: ProjectInput): Promise<Project> {
  const createdAt = new Date().toISOString();
  const project: Project = {
    id: `prj_${crypto.randomUUID()}`,
    ownerId,
    ...input,
    status: "draft",
    storyBible: DEFAULT_STORY_BIBLE,
    createdAt,
    updatedAt: createdAt,
  };

  return withMemoryFallback(
    async (db) => {
      await db.insert(projectsTable).values({
        id: project.id,
        ownerId: project.ownerId,
        name: project.name,
        brief: project.brief,
        template: project.template,
        aspectRatio: project.aspectRatio,
        targetDurationSeconds: project.targetDurationSeconds,
        model: project.model,
        status: project.status,
        storyBibleJson: JSON.stringify(project.storyBible),
        createdAt,
        updatedAt: createdAt,
      });
      return project;
    },
    () => memory.createProject(input, ownerId),
  );
}

export async function listOwnedScenes(ownerId: string, projectId: string): Promise<Scene[]> {
  const project = await getOwnedProject(ownerId, projectId);
  if (!project) return [];
  return withMemoryFallback(
    async (db) => {
      const rows = await db
        .select()
        .from(scenesTable)
        .where(eq(scenesTable.projectId, projectId))
        .orderBy(scenesTable.sceneIndex);
      return rows.map(sceneFromRow);
    },
    () => memory.getProjectScenes(projectId),
  );
}

export async function saveOwnedScenes(
  ownerId: string,
  projectId: string,
  sceneList: Scene[],
): Promise<Scene[] | null> {
  const project = await getOwnedProject(ownerId, projectId);
  if (!project) return null;
  const now = new Date().toISOString();

  return withMemoryFallback(
    async (db) => {
      await db.delete(scenesTable).where(eq(scenesTable.projectId, projectId));
      if (sceneList.length > 0) {
        await db.insert(scenesTable).values(
          sceneList.map((scene) => ({
            id: scene.id,
            projectId,
            storyboardId: null,
            sceneIndex: scene.sceneIndex,
            title: scene.title,
            durationSeconds: scene.durationSeconds,
            status: scene.status,
            startState: scene.startState,
            action: scene.action,
            endState: scene.endState,
            prompt: scene.prompt,
            negativePrompt: scene.negativePrompt,
            transition: scene.transition,
            dependsOnSceneId: scene.dependsOnSceneId,
            startFrameKey: scene.startFrameUri,
            endFrameKey: scene.endFrameUri,
            outputVideoKey: scene.outputVideoUri,
            qualityScore: scene.qualityScore,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
      await db
        .update(projectsTable)
        .set({ status: "planning", updatedAt: now })
        .where(eq(projectsTable.id, projectId));
      return sceneList;
    },
    () => memory.saveScenes(projectId, sceneList),
  );
}

export async function getOwnedScene(ownerId: string, sceneId: string): Promise<Scene | null> {
  return withMemoryFallback(
    async (db) => {
      const [row] = await db.select().from(scenesTable).where(eq(scenesTable.id, sceneId)).limit(1);
      if (!row) return null;
      const project = await getOwnedProject(ownerId, row.projectId);
      return project ? sceneFromRow(row) : null;
    },
    () => {
      const scene = memory.getScene(sceneId);
      if (!scene || !memory.getProject(scene.projectId, ownerId)) return null;
      return scene;
    },
  );
}

export async function updateOwnedScene(
  ownerId: string,
  sceneId: string,
  patch: Partial<Scene>,
): Promise<Scene | null> {
  const scene = await getOwnedScene(ownerId, sceneId);
  if (!scene) return null;
  const updated: Scene = { ...scene, ...patch };
  const now = new Date().toISOString();

  return withMemoryFallback(
    async (db) => {
      await db
        .update(scenesTable)
        .set({
          status: updated.status,
          startState: updated.startState,
          action: updated.action,
          endState: updated.endState,
          prompt: updated.prompt,
          negativePrompt: updated.negativePrompt,
          transition: updated.transition,
          dependsOnSceneId: updated.dependsOnSceneId,
          startFrameKey: updated.startFrameUri,
          endFrameKey: updated.endFrameUri,
          outputVideoKey: updated.outputVideoUri,
          qualityScore: updated.qualityScore,
          updatedAt: now,
        })
        .where(eq(scenesTable.id, sceneId));
      return updated;
    },
    () => memory.updateScene(sceneId, patch),
  );
}

export async function invalidateOwnedDownstreamScenes(
  ownerId: string,
  projectId: string,
  afterSceneIndex: number,
): Promise<void> {
  if (!(await getOwnedProject(ownerId, projectId))) return;
  const now = new Date().toISOString();
  await withMemoryFallback(
    async (db) => {
      await db
        .update(scenesTable)
        .set({
          status: "waiting_previous",
          startFrameKey: null,
          endFrameKey: null,
          outputVideoKey: null,
          qualityScore: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(scenesTable.projectId, projectId),
            gt(scenesTable.sceneIndex, afterSceneIndex),
          ),
        );
    },
    () => {
      for (const downstream of memory.getProjectScenes(projectId)) {
        if (downstream.sceneIndex <= afterSceneIndex) continue;
        memory.updateScene(downstream.id, {
          status: "waiting_previous",
          startFrameUri: null,
          endFrameUri: null,
          outputVideoUri: null,
          qualityScore: null,
        });
      }
    },
  );
}

export async function createOwnedJob(
  ownerId: string,
  job: GenerationJob,
): Promise<GenerationJob | null> {
  const project = await getOwnedProject(ownerId, job.projectId);
  if (!project) return null;
  return withMemoryFallback(
    async (db) => {
      await db.insert(generationJobsTable).values({
        id: job.id,
        projectId: job.projectId,
        sceneId: job.sceneId,
        provider: job.provider,
        providerOperationId: job.providerOperationId,
        model: job.model,
        status: job.status,
        progress: job.progress,
        attempt: job.attempt,
        idempotencyKey: `${job.sceneId}:${job.attempt}:${job.id}`,
        estimatedCostUsd: job.estimatedCostUsd,
        errorCode: job.errorCode,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
      return job;
    },
    () => memory.saveJob(job),
  );
}

export async function findOwnedActiveJobForScene(
  ownerId: string,
  sceneId: string,
): Promise<GenerationJob | null> {
  if (!(await getOwnedScene(ownerId, sceneId))) return null;
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(generationJobsTable)
        .where(
          and(
            eq(generationJobsTable.sceneId, sceneId),
            inArray(generationJobsTable.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(generationJobsTable.createdAt))
        .limit(1);
      return row ? jobFromRow(row) : null;
    },
    () => memory.findActiveJobForScene(sceneId),
  );
}

export async function createOwnedAsset(
  ownerId: string,
  asset: Omit<AssetRecord, "ownerId" | "createdAt">,
): Promise<AssetRecord | null> {
  if (!(await getOwnedProject(ownerId, asset.projectId))) return null;
  const record: AssetRecord = {
    ...asset,
    ownerId,
    createdAt: new Date().toISOString(),
  };
  return withMemoryFallback(
    async (db) => {
      await db.insert(assetsTable).values(record);
      return record;
    },
    () => record,
  );
}

export async function getCreditBalance(ownerId: string): Promise<number> {
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select({ balance: creditLedgerTable.balanceAfter })
        .from(creditLedgerTable)
        .where(eq(creditLedgerTable.ownerId, ownerId))
        .orderBy(desc(creditLedgerTable.createdAt))
        .limit(1);
      return row?.balance ?? 0;
    },
    () => 100,
  );
}

export async function chargeCredits(input: {
  ownerId: string;
  projectId: string;
  jobId: string;
  amount: number;
}): Promise<number | null> {
  const balance = await getCreditBalance(input.ownerId);
  if (balance < input.amount) return null;
  const balanceAfter = Math.round((balance - input.amount) * 100) / 100;
  return withMemoryFallback(
    async (db) => {
      await db.insert(creditLedgerTable).values({
        id: `credit_job_${input.jobId}`,
        ownerId: input.ownerId,
        projectId: input.projectId,
        jobId: input.jobId,
        kind: "generation_debit",
        amountCredits: -input.amount,
        balanceAfter,
        note: "Veo scene generation",
        createdAt: new Date().toISOString(),
      });
      return balanceAfter;
    },
    () => balanceAfter,
  );
}

export async function createOwnedRender(
  ownerId: string,
  render: FinalRender,
): Promise<FinalRender | null> {
  if (!(await getOwnedProject(ownerId, render.projectId))) return null;
  return withMemoryFallback(
    async (db) => {
      await db.insert(finalRendersTable).values({
        id: render.id,
        projectId: render.projectId,
        status: render.status,
        manifestJson: JSON.stringify(render.manifest),
        outputVideoKey: render.outputVideoUri,
        durationSeconds: render.durationSeconds,
        createdAt: render.createdAt,
        updatedAt: render.updatedAt,
      });
      return render;
    },
    () => memory.saveRender(render),
  );
}

export async function getOwnedRender(ownerId: string, renderId: string): Promise<FinalRender | null> {
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(finalRendersTable)
        .where(eq(finalRendersTable.id, renderId))
        .limit(1);
      if (!row || !(await getOwnedProject(ownerId, row.projectId))) return null;
      return {
        id: row.id,
        projectId: row.projectId,
        status: row.status as FinalRender["status"],
        manifest: JSON.parse(row.manifestJson) as FinalRender["manifest"],
        outputVideoUri: row.outputVideoKey,
        durationSeconds: row.durationSeconds,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
    () => {
      const render = memory.getRender(renderId);
      if (!render || !memory.getProject(render.projectId, ownerId)) return null;
      return render;
    },
  );
}

export async function findOwnedActiveRenderForProject(
  ownerId: string,
  projectId: string,
): Promise<FinalRender | null> {
  if (!(await getOwnedProject(ownerId, projectId))) return null;
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(finalRendersTable)
        .where(
          and(
            eq(finalRendersTable.projectId, projectId),
            inArray(finalRendersTable.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(finalRendersTable.createdAt))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.projectId,
        status: row.status as FinalRender["status"],
        manifest: JSON.parse(row.manifestJson) as FinalRender["manifest"],
        outputVideoUri: row.outputVideoKey,
        durationSeconds: row.durationSeconds,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
    () => memory.findActiveRenderForProject(projectId),
  );
}

export async function updateOwnedRender(
  ownerId: string,
  renderId: string,
  patch: Partial<FinalRender>,
): Promise<FinalRender | null> {
  const render = await getOwnedRender(ownerId, renderId);
  if (!render) return null;
  const updated: FinalRender = { ...render, ...patch, updatedAt: new Date().toISOString() };
  return withMemoryFallback(
    async (db) => {
      await db
        .update(finalRendersTable)
        .set({
          status: updated.status,
          manifestJson: JSON.stringify(updated.manifest),
          outputVideoKey: updated.outputVideoUri,
          durationSeconds: updated.durationSeconds,
          updatedAt: updated.updatedAt,
        })
        .where(eq(finalRendersTable.id, renderId));
      return updated;
    },
    () => memory.updateRender(renderId, patch),
  );
}

export async function getOwnedJob(ownerId: string, jobId: string): Promise<GenerationJob | null> {
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(generationJobsTable)
        .where(eq(generationJobsTable.id, jobId))
        .limit(1);
      if (!row || !(await getOwnedProject(ownerId, row.projectId))) return null;
      return jobFromRow(row);
    },
    () => {
      const job = memory.getJob(jobId);
      if (!job || !memory.getProject(job.projectId, ownerId)) return null;
      return job;
    },
  );
}

export async function updateOwnedJob(
  ownerId: string,
  jobId: string,
  patch: Partial<GenerationJob>,
): Promise<GenerationJob | null> {
  const job = await getOwnedJob(ownerId, jobId);
  if (!job) return null;
  const updated: GenerationJob = { ...job, ...patch, updatedAt: new Date().toISOString() };
  return withMemoryFallback(
    async (db) => {
      await db
        .update(generationJobsTable)
        .set({
          status: updated.status,
          progress: updated.progress,
          providerOperationId: updated.providerOperationId,
          errorCode: updated.errorCode,
          updatedAt: updated.updatedAt,
        })
        .where(eq(generationJobsTable.id, jobId));
      return updated;
    },
    () => memory.updateJob(jobId, patch),
  );
}

export async function advanceOwnedMockJob(
  ownerId: string,
  jobId: string,
): Promise<GenerationJob | null> {
  const job = await getOwnedJob(ownerId, jobId);
  if (!job || job.provider !== "mock" || ["done", "failed", "canceled"].includes(job.status)) return job;

  const progress = job.status === "queued" ? 28 : Math.min(100, job.progress + 36);
  const status = progress >= 100 ? "done" : "running";
  const updated: GenerationJob = {
    ...job,
    status,
    progress,
    updatedAt: new Date().toISOString(),
  };

  await withMemoryFallback(
    async (db) => {
      await db
        .update(generationJobsTable)
        .set({ status, progress, updatedAt: updated.updatedAt })
        .where(eq(generationJobsTable.id, jobId));
    },
    () => {
      memory.updateJob(jobId, updated);
    },
  );

  await updateOwnedScene(ownerId, job.sceneId, {
    status: status === "done" ? "approved" : "generating",
    outputVideoUri: status === "done" ? `mock://renders/${job.projectId}/${job.sceneId}.mp4` : null,
    endFrameUri: status === "done" ? `mock://frames/${job.projectId}/${job.sceneId}-last.jpg` : null,
    qualityScore: status === "done" ? 94 : null,
  });
  return updated;
}

function projectFromRow(row: typeof projectsTable.$inferSelect): Project {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    brief: row.brief,
    template: row.template,
    aspectRatio: row.aspectRatio as Project["aspectRatio"],
    targetDurationSeconds: row.targetDurationSeconds,
    model: row.model as Project["model"],
    status: row.status as Project["status"],
    storyBible: parseStoryBible(row.storyBibleJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sceneFromRow(row: typeof scenesTable.$inferSelect): Scene {
  return {
    id: row.id,
    projectId: row.projectId,
    sceneIndex: row.sceneIndex,
    title: row.title,
    durationSeconds: row.durationSeconds,
    status: row.status as Scene["status"],
    startState: row.startState,
    action: row.action,
    endState: row.endState,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    transition: row.transition as Scene["transition"],
    dependsOnSceneId: row.dependsOnSceneId,
    startFrameUri: row.startFrameKey,
    endFrameUri: row.endFrameKey,
    outputVideoUri: row.outputVideoKey,
    qualityScore: row.qualityScore,
  };
}

function jobFromRow(row: typeof generationJobsTable.$inferSelect): GenerationJob {
  return {
    id: row.id,
    projectId: row.projectId,
    sceneId: row.sceneId,
    provider: row.provider as GenerationJob["provider"],
    providerOperationId: row.providerOperationId,
    model: row.model as GenerationJob["model"],
    status: row.status as GenerationJob["status"],
    progress: row.progress,
    attempt: row.attempt,
    estimatedCostUsd: row.estimatedCostUsd,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStoryBible(value: string): StoryBible {
  try {
    return { ...DEFAULT_STORY_BIBLE, ...(JSON.parse(value) as Partial<StoryBible>) };
  } catch {
    return DEFAULT_STORY_BIBLE;
  }
}
