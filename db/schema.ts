import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    brief: text("brief").notNull(),
    template: text("template").notNull(),
    aspectRatio: text("aspect_ratio").notNull(),
    targetDurationSeconds: integer("target_duration_seconds").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(),
    storyBibleJson: text("story_bible_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("projects_owner_updated_idx").on(table.ownerId, table.updatedAt)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    ownerId: text("owner_id").notNull(),
    kind: text("kind").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("assets_project_idx").on(table.projectId)],
);

export const storyboards = sqliteTable(
  "storyboards",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    sourcePrompt: text("source_prompt").notNull(),
    compiledJson: text("compiled_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("storyboards_project_version_idx").on(table.projectId, table.version)],
);

export const scenes = sqliteTable(
  "scenes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    storyboardId: text("storyboard_id"),
    sceneIndex: integer("scene_index").notNull(),
    title: text("title").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    status: text("status").notNull(),
    startState: text("start_state").notNull(),
    action: text("action").notNull(),
    endState: text("end_state").notNull(),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt").notNull(),
    transition: text("transition").notNull(),
    dependsOnSceneId: text("depends_on_scene_id"),
    startFrameKey: text("start_frame_key"),
    endFrameKey: text("end_frame_key"),
    outputVideoKey: text("output_video_key"),
    qualityScore: real("quality_score"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("scenes_project_index_idx").on(table.projectId, table.sceneIndex)],
);

export const generationJobs = sqliteTable(
  "generation_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sceneId: text("scene_id").notNull(),
    provider: text("provider").notNull(),
    providerOperationId: text("provider_operation_id"),
    model: text("model").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull(),
    attempt: integer("attempt").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    estimatedCostUsd: real("estimated_cost_usd").notNull(),
    errorCode: text("error_code"),
    extractionClaimToken: text("extraction_claim_token"),
    extractionClaimKind: text("extraction_claim_kind"),
    extractionClaimExpiresAt: text("extraction_claim_expires_at"),
    extractionFailureCode: text("extraction_failure_code"),
    stateVersion: integer("state_version").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("generation_jobs_idempotency_idx").on(table.idempotencyKey),
    uniqueIndex("generation_jobs_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("generation_jobs_project_status_idx").on(table.projectId, table.status),
    check(
      "generation_jobs_extraction_claim_token_check",
      sql`${table.extractionClaimToken} is null or length(${table.extractionClaimToken}) between 1 and 128`,
    ),
    check(
      "generation_jobs_extraction_claim_kind_check",
      sql`${table.extractionClaimKind} is null or ${table.extractionClaimKind} in ('completion', 'failure')`,
    ),
    check(
      "generation_jobs_extraction_failure_code_check",
      sql`${table.extractionFailureCode} is null or ${table.extractionFailureCode} = 'end_frame_extraction_failed'`,
    ),
    check("generation_jobs_state_version_check", sql`${table.stateVersion} >= 0`),
  ],
);

export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    sceneId: text("scene_id"),
    version: integer("version").notNull(),
    rawPrompt: text("raw_prompt").notNull(),
    optimizedPrompt: text("optimized_prompt").notNull(),
    assumptionsJson: text("assumptions_json").notNull(),
    accepted: integer("accepted", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("prompt_versions_scene_idx").on(table.sceneId, table.version)],
);

export const finalRenders = sqliteTable(
  "final_renders",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull(),
    manifestJson: text("manifest_json").notNull(),
    outputVideoKey: text("output_video_key"),
    durationSeconds: real("duration_seconds"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("final_renders_project_idx").on(table.projectId, table.createdAt),
    uniqueIndex("final_renders_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

export const creditLedger = sqliteTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    projectId: text("project_id"),
    jobId: text("job_id"),
    kind: text("kind").notNull(),
    amountCredits: real("amount_credits").notNull(),
    balanceAfter: real("balance_after").notNull(),
    note: text("note").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("credit_ledger_owner_created_idx").on(table.ownerId, table.createdAt)],
);
