import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
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
import type {
  AssetRecord,
  ExtractionClaimKind,
  FinalRender,
  GenerationJob,
  GenerationJobProcessingState,
  Project,
  Scene,
  StoryBible,
} from "./types";

type Db = ReturnType<typeof getDb>;
type ProjectInput = Pick<
  Project,
  "name" | "brief" | "template" | "aspectRatio" | "targetDurationSeconds" | "model"
>;

const EXTRACTION_CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

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

export async function transitionOwnedSceneFromStatus(
  ownerId: string,
  sceneId: string,
  expectedStatus: Scene["status"],
  patch: Partial<Scene>,
): Promise<Scene | null> {
  const scene = await getOwnedScene(ownerId, sceneId);
  if (!scene || scene.status !== expectedStatus) return null;
  const now = new Date().toISOString();

  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .update(scenesTable)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.startState !== undefined ? { startState: patch.startState } : {}),
          ...(patch.action !== undefined ? { action: patch.action } : {}),
          ...(patch.endState !== undefined ? { endState: patch.endState } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.negativePrompt !== undefined ? { negativePrompt: patch.negativePrompt } : {}),
          ...(patch.transition !== undefined ? { transition: patch.transition } : {}),
          ...(patch.dependsOnSceneId !== undefined
            ? { dependsOnSceneId: patch.dependsOnSceneId }
            : {}),
          ...(patch.startFrameUri !== undefined ? { startFrameKey: patch.startFrameUri } : {}),
          ...(patch.endFrameUri !== undefined ? { endFrameKey: patch.endFrameUri } : {}),
          ...(patch.outputVideoUri !== undefined
            ? { outputVideoKey: patch.outputVideoUri }
            : {}),
          ...(patch.qualityScore !== undefined ? { qualityScore: patch.qualityScore } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(scenesTable.id, sceneId),
            eq(scenesTable.status, expectedStatus),
            sql`exists (
              select 1
              from ${projectsTable}
              where ${projectsTable.id} = ${scenesTable.projectId}
                and ${projectsTable.ownerId} = ${ownerId}
            )`,
          ),
        )
        .returning();
      return row ? sceneFromRow(row) : null;
    },
    () => {
      const current = memory.getScene(sceneId);
      if (
        !current ||
        !memory.getProject(current.projectId, ownerId)
      ) {
        return null;
      }
      return memory.transitionSceneFromStatus(sceneId, expectedStatus, patch);
    },
  );
}

export async function transitionOwnedSceneFromStatusForJobClaim(
  ownerId: string,
  sceneId: string,
  expectedStatus: Scene["status"],
  jobId: string,
  expectedClaimToken: string,
  expectedClaimKind: ExtractionClaimKind,
  patch: Partial<Scene>,
): Promise<Scene | null> {
  const scene = await getOwnedScene(ownerId, sceneId);
  const job = await getOwnedJobProcessingState(ownerId, jobId);
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
  const now = new Date().toISOString();

  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .update(scenesTable)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.startState !== undefined ? { startState: patch.startState } : {}),
          ...(patch.action !== undefined ? { action: patch.action } : {}),
          ...(patch.endState !== undefined ? { endState: patch.endState } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.negativePrompt !== undefined ? { negativePrompt: patch.negativePrompt } : {}),
          ...(patch.transition !== undefined ? { transition: patch.transition } : {}),
          ...(patch.dependsOnSceneId !== undefined
            ? { dependsOnSceneId: patch.dependsOnSceneId }
            : {}),
          ...(patch.startFrameUri !== undefined ? { startFrameKey: patch.startFrameUri } : {}),
          ...(patch.endFrameUri !== undefined ? { endFrameKey: patch.endFrameUri } : {}),
          ...(patch.outputVideoUri !== undefined
            ? { outputVideoKey: patch.outputVideoUri }
            : {}),
          ...(patch.qualityScore !== undefined ? { qualityScore: patch.qualityScore } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(scenesTable.id, sceneId),
            eq(scenesTable.status, expectedStatus),
            sql`exists (
              select 1
              from ${generationJobsTable}
              where ${generationJobsTable.id} = ${jobId}
                and ${generationJobsTable.sceneId} = ${sceneId}
                and ${generationJobsTable.projectId} = ${scenesTable.projectId}
                and ${generationJobsTable.status} in ('queued', 'running')
                and ${generationJobsTable.extractionClaimToken} = ${expectedClaimToken}
                and ${generationJobsTable.extractionClaimKind} = ${expectedClaimKind}
                and ${
                  expectedClaimKind === "completion"
                    ? sql`${generationJobsTable.extractionFailureCode} is null`
                    : sql`${generationJobsTable.extractionFailureCode} = 'end_frame_extraction_failed'`
                }
                and exists (
                  select 1
                  from ${projectsTable}
                  where ${projectsTable.id} = ${generationJobsTable.projectId}
                    and ${projectsTable.ownerId} = ${ownerId}
                )
            )`,
          ),
        )
        .returning();
      return row ? sceneFromRow(row) : null;
    },
    () => {
      const current = memory.getScene(sceneId);
      if (!current || !memory.getProject(current.projectId, ownerId)) return null;
      return memory.transitionSceneFromStatusForJobClaim(
        sceneId,
        expectedStatus,
        jobId,
        expectedClaimToken,
        expectedClaimKind,
        patch,
      );
    },
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
    () => generationJobFromProcessingState(memory.saveJob(job)),
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
      return row ? generationJobFromProcessingState(processingJobFromRow(row)) : null;
    },
    () => {
      const job = memory.findActiveJobForScene(sceneId);
      return job ? generationJobFromProcessingState(job) : null;
    },
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
  const job = await getOwnedJobProcessingState(ownerId, jobId);
  return job ? generationJobFromProcessingState(job) : null;
}

export async function getOwnedJobProcessingState(
  ownerId: string,
  jobId: string,
): Promise<GenerationJobProcessingState | null> {
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(generationJobsTable)
        .where(
          and(
            eq(generationJobsTable.id, jobId),
            sql`exists (
              select 1
              from ${projectsTable}
              where ${projectsTable.id} = ${generationJobsTable.projectId}
                and ${projectsTable.ownerId} = ${ownerId}
            )`,
          ),
        )
        .limit(1);
      return row ? processingJobFromRow(row) : null;
    },
    () => {
      const job = memory.getJob(jobId);
      if (!job || !memory.getProject(job.projectId, ownerId)) return null;
      return job;
    },
  );
}

export async function transitionOwnedJobFromSnapshot(
  ownerId: string,
  jobId: string,
  expected: Pick<GenerationJobProcessingState, "status" | "stateVersion">,
  patch: Partial<GenerationJobProcessingState>,
): Promise<GenerationJobProcessingState | null> {
  if (
    patch.extractionClaimToken !== undefined &&
    patch.extractionClaimToken !== null &&
    !EXTRACTION_CLAIM_TOKEN_PATTERN.test(patch.extractionClaimToken)
  ) {
    return null;
  }
  const job = await getOwnedJobProcessingState(ownerId, jobId);
  if (!job || job.status !== expected.status || job.stateVersion !== expected.stateVersion) {
    return null;
  }
  const updatedAt = new Date().toISOString();

  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .update(generationJobsTable)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
          ...(patch.providerOperationId !== undefined
            ? { providerOperationId: patch.providerOperationId }
            : {}),
          ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
          ...(patch.extractionClaimToken !== undefined
            ? { extractionClaimToken: patch.extractionClaimToken }
            : {}),
          ...(patch.extractionClaimKind !== undefined
            ? { extractionClaimKind: patch.extractionClaimKind }
            : {}),
          ...(patch.extractionClaimExpiresAt !== undefined
            ? { extractionClaimExpiresAt: patch.extractionClaimExpiresAt }
            : {}),
          ...(patch.extractionFailureCode !== undefined
            ? { extractionFailureCode: patch.extractionFailureCode }
            : {}),
          stateVersion: sql`${generationJobsTable.stateVersion} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(generationJobsTable.id, jobId),
            eq(generationJobsTable.status, expected.status),
            eq(generationJobsTable.stateVersion, expected.stateVersion),
            sql`exists (
              select 1
              from ${projectsTable}
              where ${projectsTable.id} = ${generationJobsTable.projectId}
                and ${projectsTable.ownerId} = ${ownerId}
            )`,
          ),
        )
        .returning();
      return row ? processingJobFromRow(row) : null;
    },
    () => {
      const current = memory.getJob(jobId);
      if (
        !current ||
        !memory.getProject(current.projectId, ownerId)
      ) {
        return null;
      }
      return memory.transitionJobFromSnapshot(jobId, expected, patch);
    },
  );
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

function processingJobFromRow(
  row: typeof generationJobsTable.$inferSelect,
): GenerationJobProcessingState {
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
    extractionClaimToken: row.extractionClaimToken,
    extractionClaimKind: row.extractionClaimKind as GenerationJobProcessingState["extractionClaimKind"],
    extractionClaimExpiresAt: row.extractionClaimExpiresAt,
    extractionFailureCode:
      row.extractionFailureCode as GenerationJobProcessingState["extractionFailureCode"],
    stateVersion: row.stateVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function generationJobFromProcessingState(job: GenerationJobProcessingState): GenerationJob {
  return {
    id: job.id,
    projectId: job.projectId,
    sceneId: job.sceneId,
    provider: job.provider,
    providerOperationId: job.providerOperationId,
    model: job.model,
    status: job.status,
    progress: job.progress,
    attempt: job.attempt,
    estimatedCostUsd: job.estimatedCostUsd,
    errorCode: job.errorCode?.startsWith("extraction_claim:") ? null : job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function parseStoryBible(value: string): StoryBible {
  try {
    return { ...DEFAULT_STORY_BIBLE, ...(JSON.parse(value) as Partial<StoryBible>) };
  } catch {
    return DEFAULT_STORY_BIBLE;
  }
}
