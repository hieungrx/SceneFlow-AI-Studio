ALTER TABLE generation_jobs
ADD COLUMN extraction_claim_token TEXT
CHECK (
  extraction_claim_token IS NULL
  OR length(extraction_claim_token) BETWEEN 1 AND 128
);

ALTER TABLE generation_jobs
ADD COLUMN extraction_claim_kind TEXT
CHECK (
  extraction_claim_kind IS NULL
  OR extraction_claim_kind IN ('completion', 'failure')
);

ALTER TABLE generation_jobs
ADD COLUMN extraction_claim_expires_at TEXT;

ALTER TABLE generation_jobs
ADD COLUMN extraction_failure_code TEXT
CHECK (
  extraction_failure_code IS NULL
  OR extraction_failure_code = 'end_frame_extraction_failed'
);

ALTER TABLE generation_jobs
ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0
CHECK (state_version >= 0);

UPDATE generation_jobs
SET
  extraction_claim_token = CASE
    WHEN error_code GLOB 'extraction_claim:completion:*'
      THEN substr(error_code, length('extraction_claim:completion:') + 1)
    WHEN error_code GLOB 'extraction_claim:failure:*'
      THEN substr(error_code, length('extraction_claim:failure:') + 1)
  END,
  extraction_claim_kind = CASE
    WHEN error_code GLOB 'extraction_claim:completion:*' THEN 'completion'
    WHEN error_code GLOB 'extraction_claim:failure:*' THEN 'failure'
  END,
  extraction_claim_expires_at =
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+3600 seconds'),
  extraction_failure_code = CASE
    WHEN error_code GLOB 'extraction_claim:failure:*'
      THEN 'end_frame_extraction_failed'
    ELSE NULL
  END,
  error_code = NULL,
  state_version = state_version + 1
WHERE
  (
    error_code GLOB 'extraction_claim:completion:*'
    AND length(
      substr(error_code, length('extraction_claim:completion:') + 1)
    ) BETWEEN 1 AND 128
  )
  OR
  (
    error_code GLOB 'extraction_claim:failure:*'
    AND length(
      substr(error_code, length('extraction_claim:failure:') + 1)
    ) BETWEEN 1 AND 128
  );

UPDATE generation_jobs
SET
  error_code = NULL,
  state_version = state_version + 1
WHERE error_code GLOB 'extraction_claim:*';
