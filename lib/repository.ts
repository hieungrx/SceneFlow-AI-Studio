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
  GenerationActivationInput,
  GenerationFailureInput,
  GenerationReservationInput,
  GenerationReservationResult,
} from "./generation-start";
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
    () => memory.ensureUser(ownerId),
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

export async function reserveOwnedGeneration(
  ownerId: string,
  input: GenerationReservationInput,
): Promise<GenerationReservationResult> {
  return withMemoryFallback(
    async (db) => {
      const client = db.$client;
      const insertJob = client.prepare(`
        INSERT OR IGNORE INTO generation_jobs (
          id, project_id, scene_id, provider, provider_operation_id, model,
          status, progress, attempt, idempotency_key, estimated_cost_usd,
          error_code, extraction_claim_token, extraction_claim_kind,
          extraction_claim_expires_at, extraction_failure_code, state_version,
          created_at, updated_at
        )
        SELECT
          ?, s.project_id, s.id, ?, NULL, p.model,
          'queued', 0,
          COALESCE((SELECT MAX(previous.attempt) FROM generation_jobs previous WHERE previous.scene_id = s.id), 0) + 1,
          s.id || ':' || CAST(COALESCE((SELECT MAX(previous.attempt) FROM generation_jobs previous WHERE previous.scene_id = s.id), 0) + 1 AS TEXT),
          ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?
        FROM scenes s
        JOIN projects p ON p.id = s.project_id
        WHERE s.id = ?
          AND s.project_id = ?
          AND p.owner_id = ?
          AND s.status IN ('planned', 'waiting_previous', 'approved', 'rejected', 'failed')
          AND (
            s.depends_on_scene_id IS NULL
            OR EXISTS (
              SELECT 1 FROM scenes previous_scene
              WHERE previous_scene.id = s.depends_on_scene_id
                AND previous_scene.project_id = s.project_id
                AND previous_scene.status = 'approved'
                AND previous_scene.end_frame_key IS NOT NULL
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM generation_jobs active_job
            WHERE active_job.project_id = s.project_id
              AND active_job.status IN ('queued', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM final_renders active_render
            WHERE active_render.project_id = s.project_id
              AND active_render.status IN ('queued', 'running')
          )
          AND COALESCE((
            SELECT balance_after FROM credit_ledger
            WHERE owner_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          ), 0) >= ?
      `).bind(
        input.jobId,
        input.provider,
        input.estimatedCostUsd,
        input.createdAt,
        input.createdAt,
        input.sceneId,
        input.projectId,
        ownerId,
        ownerId,
        input.requiredCredits,
      );
      const debitCredit = client.prepare(`
        INSERT INTO credit_ledger (
          id, owner_id, project_id, job_id, kind, amount_credits,
          balance_after, note, created_at
        )
        SELECT
          ?, ?, s.project_id, ?, 'generation_debit', ?,
          latest.balance_after - ?, 'Veo scene generation reservation', ?
        FROM scenes s
        JOIN (
          SELECT balance_after FROM credit_ledger
          WHERE owner_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        ) latest
        WHERE s.id = ?
          AND EXISTS (SELECT 1 FROM generation_jobs WHERE id = ?)
      `).bind(
        `credit_job_${input.jobId}`,
        ownerId,
        input.jobId,
        -input.requiredCredits,
        input.requiredCredits,
        input.createdAt,
        ownerId,
        input.sceneId,
        input.jobId,
      );
      await client.batch([insertJob, debitCredit]);

      const [insertedRow] = await db
        .select()
        .from(generationJobsTable)
        .where(eq(generationJobsTable.id, input.jobId))
        .limit(1);
      if (insertedRow) {
        const [projectRow] = await db
          .select()
          .from(projectsTable)
          .where(and(eq(projectsTable.id, input.projectId), eq(projectsTable.ownerId, ownerId)))
          .limit(1);
        const [sceneRow] = await db
          .select()
          .from(scenesTable)
          .where(eq(scenesTable.id, input.sceneId))
          .limit(1);
        if (!projectRow || !sceneRow) {
          return { kind: "blocked", error: "scene_generation_inconsistent" };
        }
        return {
          kind: "reserved",
          job: processingJobFromRow(insertedRow),
          project: projectFromRow(projectRow),
          scene: await resolveDbSubmissionScene(db, sceneFromRow(sceneRow)),
          balanceAfter: await getDbCreditBalance(db, ownerId),
        };
      }

      return classifyDbGenerationReservation(db, ownerId, input);
    },
    () => memory.reserveGeneration(ownerId, input),
  );
}

export async function activateOwnedGeneration(
  ownerId: string,
  input: GenerationActivationInput,
): Promise<GenerationJobProcessingState | null> {
  const updatedAt = new Date().toISOString();
  return withMemoryFallback(
    async (db) => {
      const client = db.$client;
      const nextVersion = input.expectedStateVersion + 1;
      await client.batch([
        client.prepare(`
          UPDATE generation_jobs
          SET provider_operation_id = ?, status = ?, progress = ?,
              error_code = NULL, state_version = state_version + 1, updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND state_version = ?
            AND provider_operation_id IS NULL
            AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?)
            AND EXISTS (
              SELECT 1 FROM projects
              WHERE projects.id = generation_jobs.project_id
                AND projects.owner_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM scenes target
              WHERE target.id = generation_jobs.scene_id
                AND target.status = ?
                AND target.status IN ('planned', 'waiting_previous', 'approved', 'rejected', 'failed')
                AND (
                  target.depends_on_scene_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM scenes previous_scene
                    WHERE previous_scene.id = target.depends_on_scene_id
                      AND previous_scene.project_id = target.project_id
                      AND previous_scene.status = 'approved'
                      AND previous_scene.end_frame_key IS NOT NULL
                  )
                )
            )
        `).bind(
          input.operation.operationId,
          input.operation.status,
          input.operation.progress,
          updatedAt,
          input.jobId,
          input.expectedStateVersion,
          `credit_job_${input.jobId}`,
          ownerId,
          input.expectedSceneStatus,
        ),
        client.prepare(`
          UPDATE scenes
          SET status = 'queued',
              start_frame_key = CASE
                WHEN depends_on_scene_id IS NULL THEN start_frame_key
                ELSE (SELECT end_frame_key FROM scenes previous_scene WHERE previous_scene.id = scenes.depends_on_scene_id)
              END,
              end_frame_key = NULL,
              output_video_key = NULL,
              quality_score = NULL,
              updated_at = ?
          WHERE id = (SELECT scene_id FROM generation_jobs WHERE id = ?)
            AND status = ?
            AND EXISTS (
              SELECT 1 FROM generation_jobs activated
              JOIN projects ON projects.id = activated.project_id
              WHERE activated.id = ?
                AND activated.provider_operation_id = ?
                AND activated.state_version = ?
                AND projects.owner_id = ?
            )
        `).bind(
          updatedAt,
          input.jobId,
          input.expectedSceneStatus,
          input.jobId,
          input.operation.operationId,
          nextVersion,
          ownerId,
        ),
        client.prepare(`
          UPDATE scenes
          SET status = 'waiting_previous', start_frame_key = NULL,
              end_frame_key = NULL, output_video_key = NULL,
              quality_score = NULL, updated_at = ?
          WHERE project_id = (SELECT project_id FROM generation_jobs WHERE id = ?)
            AND scene_index > (
              SELECT scene_index FROM scenes
              WHERE id = (SELECT scene_id FROM generation_jobs WHERE id = ?)
            )
            AND ? IN ('approved', 'rejected', 'failed')
            AND EXISTS (
              SELECT 1 FROM generation_jobs activated
              JOIN projects ON projects.id = activated.project_id
              WHERE activated.id = ?
                AND activated.provider_operation_id = ?
                AND activated.state_version = ?
                AND projects.owner_id = ?
            )
        `).bind(
          updatedAt,
          input.jobId,
          input.jobId,
          input.expectedSceneStatus,
          input.jobId,
          input.operation.operationId,
          nextVersion,
          ownerId,
        ),
      ]);
      const [row] = await db
        .select()
        .from(generationJobsTable)
        .where(
          and(
            eq(generationJobsTable.id, input.jobId),
            eq(generationJobsTable.providerOperationId, input.operation.operationId),
            eq(generationJobsTable.stateVersion, nextVersion),
          ),
        )
        .limit(1);
      return row ? processingJobFromRow(row) : null;
    },
    () => memory.activateGeneration(ownerId, input),
  );
}

export async function failOwnedGenerationSubmissionAndRefund(
  ownerId: string,
  input: GenerationFailureInput,
): Promise<{ job: GenerationJobProcessingState; balanceAfter: number } | null> {
  const updatedAt = new Date().toISOString();
  return withMemoryFallback(
    async (db) => {
      const client = db.$client;
      const nextVersion = input.expectedStateVersion + 1;
      await client.batch([
        client.prepare(`
          UPDATE generation_jobs
          SET status = 'failed', progress = 0, error_code = ?,
              state_version = state_version + 1, updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND state_version = ?
            AND provider_operation_id IS NULL
            AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?)
            AND EXISTS (
              SELECT 1 FROM projects
              WHERE projects.id = generation_jobs.project_id
                AND projects.owner_id = ?
            )
        `).bind(
          input.errorCode,
          updatedAt,
          input.jobId,
          input.expectedStateVersion,
          `credit_job_${input.jobId}`,
          ownerId,
        ),
        client.prepare(`
          INSERT OR IGNORE INTO credit_ledger (
            id, owner_id, project_id, job_id, kind, amount_credits,
            balance_after, note, created_at
          )
          SELECT
            ?, ?, failed.project_id, failed.id, 'generation_refund', ?,
            latest.balance_after + ?, 'Veo submission rejected refund', ?
          FROM generation_jobs failed
          JOIN (
            SELECT balance_after FROM credit_ledger
            WHERE owner_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          ) latest
          WHERE failed.id = ?
            AND failed.status = 'failed'
            AND failed.state_version = ?
            AND failed.error_code = ?
            AND EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?)
        `).bind(
          `credit_refund_${input.jobId}`,
          ownerId,
          input.requiredCredits,
          input.requiredCredits,
          updatedAt,
          ownerId,
          input.jobId,
          nextVersion,
          input.errorCode,
          `credit_job_${input.jobId}`,
        ),
      ]);
      const [row] = await db
        .select()
        .from(generationJobsTable)
        .where(
          and(
            eq(generationJobsTable.id, input.jobId),
            eq(generationJobsTable.status, "failed"),
            eq(generationJobsTable.stateVersion, nextVersion),
          ),
        )
        .limit(1);
      return row
        ? { job: processingJobFromRow(row), balanceAfter: await getDbCreditBalance(db, ownerId) }
        : null;
    },
    () => memory.failGenerationSubmissionAndRefund(ownerId, input),
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

export async function findOwnedActiveJobForProject(
  ownerId: string,
  projectId: string,
): Promise<GenerationJob | null> {
  if (!(await getOwnedProject(ownerId, projectId))) return null;
  return withMemoryFallback(
    async (db) => {
      const [row] = await db
        .select()
        .from(generationJobsTable)
        .where(
          and(
            eq(generationJobsTable.projectId, projectId),
            inArray(generationJobsTable.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(generationJobsTable.createdAt))
        .limit(1);
      return row ? generationJobFromProcessingState(processingJobFromRow(row)) : null;
    },
    () => {
      const job = memory.findActiveJobForProject(projectId);
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
    () => memory.getCreditBalance(ownerId),
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
    () => memory.chargeCredits(input.ownerId, input.jobId, input.amount),
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

export type FinalRenderReservationResult =
  | { kind: "reserved"; render: FinalRender }
  | { kind: "reused"; render: FinalRender }
  | { kind: "blocked"; error: "project_not_found" | "scenes_not_ready" | "generation_in_progress" };

export async function reserveOwnedFinalRender(
  ownerId: string,
  render: FinalRender,
): Promise<FinalRenderReservationResult> {
  return withMemoryFallback(
    async (db) => {
      const manifestScenes = render.manifest.scenes;
      const sceneGuards = manifestScenes.map(
        () => `EXISTS (
          SELECT 1 FROM scenes ready_scene
          WHERE ready_scene.id = ?
            AND ready_scene.project_id = ?
            AND ready_scene.status = 'approved'
            AND ready_scene.output_video_key = ?
        )`,
      );
      const sqlText = `
        INSERT OR IGNORE INTO final_renders (
          id, project_id, status, manifest_json, output_video_key,
          duration_seconds, created_at, updated_at
        )
        SELECT ?, ?, 'queued', ?, NULL, NULL, ?, ?
        WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM generation_jobs
            WHERE project_id = ? AND status IN ('queued', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM final_renders
            WHERE project_id = ? AND status IN ('queued', 'running')
          )
          AND NOT EXISTS (
            SELECT 1 FROM final_renders
            WHERE project_id = ? AND status = 'done' AND manifest_json = ?
          )
          AND (SELECT COUNT(*) FROM scenes WHERE project_id = ?) = ?
          ${sceneGuards.length > 0 ? `AND ${sceneGuards.join(" AND ")}` : "AND 0"}
      `;
      const guardBindings = manifestScenes.flatMap((scene) => [
        scene.sceneId,
        render.projectId,
        scene.sourceUri,
      ]);
      await db.$client
        .prepare(sqlText)
        .bind(
          render.id,
          render.projectId,
          JSON.stringify(render.manifest),
          render.createdAt,
          render.updatedAt,
          render.projectId,
          ownerId,
          render.projectId,
          render.projectId,
          render.projectId,
          JSON.stringify(render.manifest),
          render.projectId,
          manifestScenes.length,
          ...guardBindings,
        )
        .run();

      const inserted = await getDbRenderById(db, render.id);
      if (inserted) return { kind: "reserved", render: inserted };
      const [projectRow] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, render.projectId), eq(projectsTable.ownerId, ownerId)))
        .limit(1);
      if (!projectRow) return { kind: "blocked", error: "project_not_found" };
      const [activeRenderRow] = await db
        .select()
        .from(finalRendersTable)
        .where(
          and(
            eq(finalRendersTable.projectId, render.projectId),
            inArray(finalRendersTable.status, ["queued", "running"]),
          ),
        )
        .orderBy(desc(finalRendersTable.createdAt))
        .limit(1);
      if (activeRenderRow) {
        return { kind: "reused", render: finalRenderFromRow(activeRenderRow) };
      }
      const [activeJob] = await db
        .select({ id: generationJobsTable.id })
        .from(generationJobsTable)
        .where(
          and(
            eq(generationJobsTable.projectId, render.projectId),
            inArray(generationJobsTable.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (activeJob) return { kind: "blocked", error: "generation_in_progress" };
      const [completedRenderRow] = await db
        .select()
        .from(finalRendersTable)
        .where(
          and(
            eq(finalRendersTable.projectId, render.projectId),
            eq(finalRendersTable.status, "done"),
            eq(finalRendersTable.manifestJson, JSON.stringify(render.manifest)),
          ),
        )
        .orderBy(desc(finalRendersTable.createdAt))
        .limit(1);
      return completedRenderRow
        ? { kind: "reused", render: finalRenderFromRow(completedRenderRow) }
        : { kind: "blocked", error: "scenes_not_ready" };
    },
    () => memory.reserveRender(ownerId, render),
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

async function classifyDbGenerationReservation(
  db: Db,
  ownerId: string,
  input: GenerationReservationInput,
): Promise<GenerationReservationResult> {
  const [sceneRow] = await db
    .select()
    .from(scenesTable)
    .where(eq(scenesTable.id, input.sceneId))
    .limit(1);
  if (!sceneRow) return { kind: "blocked", error: "scene_not_found" };
  const [projectRow] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, sceneRow.projectId), eq(projectsTable.ownerId, ownerId)))
    .limit(1);
  if (!projectRow) return { kind: "blocked", error: "scene_not_found" };
  const scene = await resolveDbSubmissionScene(db, sceneFromRow(sceneRow));
  const project = projectFromRow(projectRow);

  const [activeJobRow] = await db
    .select()
    .from(generationJobsTable)
    .where(
      and(
        eq(generationJobsTable.projectId, project.id),
        inArray(generationJobsTable.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(generationJobsTable.createdAt))
    .limit(1);
  if (activeJobRow) {
    const activeJob = processingJobFromRow(activeJobRow);
    return activeJob.sceneId === scene.id
      ? { kind: "reused", job: activeJob, project, scene }
      : { kind: "blocked", error: "project_generation_in_progress", job: activeJob };
  }

  const [activeRenderRow] = await db
    .select({ id: finalRendersTable.id })
    .from(finalRendersTable)
    .where(
      and(
        eq(finalRendersTable.projectId, project.id),
        inArray(finalRendersTable.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (activeRenderRow) return { kind: "blocked", error: "project_render_in_progress" };

  if (scene.status === "quality_check") {
    return { kind: "blocked", error: "scene_requires_qc_decision" };
  }
  if (scene.status === "queued" || scene.status === "generating") {
    return { kind: "blocked", error: "scene_generation_inconsistent" };
  }
  if (!(["planned", "waiting_previous", "approved", "rejected", "failed"] as const).includes(
    scene.status as "planned" | "waiting_previous" | "approved" | "rejected" | "failed",
  )) {
    return { kind: "blocked", error: "invalid_scene_generation_status" };
  }
  if (scene.dependsOnSceneId) {
    const [previousRow] = await db
      .select()
      .from(scenesTable)
      .where(eq(scenesTable.id, scene.dependsOnSceneId))
      .limit(1);
    if (
      !previousRow ||
      previousRow.projectId !== scene.projectId ||
      previousRow.status !== "approved" ||
      !previousRow.endFrameKey
    ) {
      return { kind: "blocked", error: "previous_scene_not_approved" };
    }
  }
  const balance = await getDbCreditBalance(db, ownerId);
  if (balance < input.requiredCredits) {
    return {
      kind: "blocked",
      error: "insufficient_credits",
      requiredCredits: input.requiredCredits,
      balance,
    };
  }
  return { kind: "blocked", error: "scene_generation_inconsistent" };
}

async function getDbCreditBalance(db: Db, ownerId: string): Promise<number> {
  const row = await db.$client
    .prepare(`
      SELECT balance_after AS balance
      FROM credit_ledger
      WHERE owner_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
    .bind(ownerId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

async function resolveDbSubmissionScene(db: Db, scene: Scene): Promise<Scene> {
  if (!scene.dependsOnSceneId) return scene;
  const [previousRow] = await db
    .select({ endFrameKey: scenesTable.endFrameKey })
    .from(scenesTable)
    .where(eq(scenesTable.id, scene.dependsOnSceneId))
    .limit(1);
  return previousRow?.endFrameKey
    ? { ...scene, startFrameUri: previousRow.endFrameKey }
    : scene;
}

async function getDbRenderById(db: Db, renderId: string): Promise<FinalRender | null> {
  const [row] = await db
    .select()
    .from(finalRendersTable)
    .where(eq(finalRendersTable.id, renderId))
    .limit(1);
  return row ? finalRenderFromRow(row) : null;
}

function finalRenderFromRow(row: typeof finalRendersTable.$inferSelect): FinalRender {
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
