import { env } from "cloudflare:workers";

let schemaPromise: Promise<unknown> | null = null;

export async function ensureDatabaseSchema(): Promise<void> {
  if (!env.DB) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  schemaPromise ??= env.DB.exec(SCHEMA_SQL);
  await schemaPromise;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, brief TEXT NOT NULL, template TEXT NOT NULL, aspect_ratio TEXT NOT NULL, target_duration_seconds INTEGER NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, story_bible_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS projects_owner_updated_idx ON projects(owner_id, updated_at);
CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL, r2_key TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assets_project_idx ON assets(project_id);
CREATE TABLE IF NOT EXISTS storyboards (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, source_prompt TEXT NOT NULL, compiled_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS storyboards_project_version_idx ON storyboards(project_id, version);
CREATE TABLE IF NOT EXISTS scenes (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, storyboard_id TEXT, scene_index INTEGER NOT NULL, title TEXT NOT NULL, duration_seconds INTEGER NOT NULL, status TEXT NOT NULL, start_state TEXT NOT NULL, action TEXT NOT NULL, end_state TEXT NOT NULL, prompt TEXT NOT NULL, negative_prompt TEXT NOT NULL, transition TEXT NOT NULL, depends_on_scene_id TEXT, start_frame_key TEXT, end_frame_key TEXT, output_video_key TEXT, quality_score REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS scenes_project_index_idx ON scenes(project_id, scene_index);
CREATE TABLE IF NOT EXISTS generation_jobs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, scene_id TEXT NOT NULL, provider TEXT NOT NULL, provider_operation_id TEXT, model TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, attempt INTEGER NOT NULL, idempotency_key TEXT NOT NULL, estimated_cost_usd REAL NOT NULL, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_idempotency_idx ON generation_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS generation_jobs_project_status_idx ON generation_jobs(project_id, status);
CREATE TABLE IF NOT EXISTS prompt_versions (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, scene_id TEXT, version INTEGER NOT NULL, raw_prompt TEXT NOT NULL, optimized_prompt TEXT NOT NULL, assumptions_json TEXT NOT NULL, accepted INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS prompt_versions_scene_idx ON prompt_versions(scene_id, version);
CREATE TABLE IF NOT EXISTS final_renders (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, manifest_json TEXT NOT NULL, output_video_key TEXT, duration_seconds REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS final_renders_project_idx ON final_renders(project_id, created_at);
CREATE TABLE IF NOT EXISTS credit_ledger (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, project_id TEXT, job_id TEXT, kind TEXT NOT NULL, amount_credits REAL NOT NULL, balance_after REAL NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS credit_ledger_owner_created_idx ON credit_ledger(owner_id, created_at);
`;
