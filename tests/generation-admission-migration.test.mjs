import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("generation admission migration is additive and installs both active-project guards", () => {
  const migration = readFileSync(
    join(root, "drizzle", "0002_generation_admission_guards.sql"),
    "utf8",
  );

  assert.match(migration, /generation_jobs_one_active_per_project_idx/);
  assert.match(migration, /final_renders_one_active_per_project_idx/);
  assert.match(migration, /WHERE status IN \('queued', 'running'\)/g);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|UPDATE|ALTER)\b/i);
});
