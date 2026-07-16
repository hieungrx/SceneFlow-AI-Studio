CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_one_active_per_project_idx
ON generation_jobs(project_id)
WHERE status IN ('queued', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS final_renders_one_active_per_project_idx
ON final_renders(project_id)
WHERE status IN ('queued', 'running');
