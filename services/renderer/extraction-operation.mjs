import { createHash } from "node:crypto";

export const EXTRACTION_REQUEST_VERSION = 1;
export const EXTRACTION_OPERATION_PREFIX = "extract-last-frame:v1:";
export const EXTRACTION_ARTIFACT_KIND = "continuity-last-frame";

export function expectedExtractionOperationId(generationJobId) {
  return `${EXTRACTION_OPERATION_PREFIX}${generationJobId}`;
}

export function buildExtractionBinding(input) {
  return {
    requestVersion: EXTRACTION_REQUEST_VERSION,
    operationId: input.operationId,
    projectId: input.projectId,
    sceneId: input.sceneId,
    generationJobId: input.generationJobId,
    videoUri: input.videoUri,
    outputGcsUri: input.outputGcsUri,
    format: "jpeg",
    expectedContentType: "image/jpeg",
  };
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function extractionBindingHash(binding) {
  return sha256(JSON.stringify(binding));
}

export function extractionOperationObject(outputObject, projectId, sceneId, generationJobId) {
  const deterministicSuffix =
    `projects/${projectId}/frames/${sceneId}-${generationJobId}-last.jpg`;
  const prefix =
    outputObject === deterministicSuffix
      ? ""
      : outputObject.endsWith(`/${deterministicSuffix}`)
        ? outputObject.slice(0, -(deterministicSuffix.length + 1))
        : null;
  if (prefix === null) {
    throw new Error("Extraction output object does not match its deterministic binding.");
  }
  return [prefix, ".veo3flow", "operations", "extract-last-frame", `${generationJobId}.json`]
    .filter(Boolean)
    .join("/");
}

export function createProcessingRecord(binding, ownerToken, nowMs, leaseDurationMs, attempt = 1) {
  return {
    recordVersion: 1,
    operationId: binding.operationId,
    requestVersion: binding.requestVersion,
    state: "processing",
    projectId: binding.projectId,
    sceneId: binding.sceneId,
    generationJobId: binding.generationJobId,
    inputUriSha256: sha256(binding.videoUri),
    outputUri: binding.outputGcsUri,
    expectedContentType: binding.expectedContentType,
    bindingHash: extractionBindingHash(binding),
    ownerToken,
    leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
    attempt,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    output: null,
    errorCode: null,
  };
}

export function classifyOperationRecord(record, binding, nowMs) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "invalid";
  if (record.bindingHash !== extractionBindingHash(binding)) return "conflict";
  if (record.state === "completed") return "completed";
  if (record.state === "failed") return "failed";
  if (record.state !== "processing") return "invalid";
  const expiresAt = Date.parse(record.leaseExpiresAt);
  if (!Number.isFinite(expiresAt)) return "invalid";
  return expiresAt > nowMs ? "processing" : "expired";
}

export function takeOverProcessingRecord(record, ownerToken, nowMs, leaseDurationMs) {
  return {
    ...record,
    state: "processing",
    ownerToken,
    leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
    attempt: Number.isInteger(record.attempt) && record.attempt >= 1 ? record.attempt + 1 : 1,
    updatedAt: new Date(nowMs).toISOString(),
    output: null,
    errorCode: null,
  };
}

export function completeProcessingRecord(record, ownerToken, output, nowMs) {
  if (record.state !== "processing" || record.ownerToken !== ownerToken) return null;
  return {
    ...record,
    state: "completed",
    ownerToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(nowMs).toISOString(),
    output,
    errorCode: null,
  };
}

export function failProcessingRecord(record, ownerToken, errorCode, nowMs) {
  if (record.state !== "processing" || record.ownerToken !== ownerToken) return null;
  return {
    ...record,
    state: "failed",
    ownerToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(nowMs).toISOString(),
    output: null,
    errorCode,
  };
}

export function extractionArtifactMetadata(binding) {
  return {
    "veo3flow-project-id": binding.projectId,
    "veo3flow-scene-id": binding.sceneId,
    "veo3flow-job-id": binding.generationJobId,
    "veo3flow-operation-id": binding.operationId,
    "veo3flow-artifact-kind": EXTRACTION_ARTIFACT_KIND,
    "veo3flow-request-version": String(EXTRACTION_REQUEST_VERSION),
    "veo3flow-input-uri-sha256": sha256(binding.videoUri),
  };
}

export function validateExtractionArtifactMetadata(objectMetadata, binding) {
  if (!objectMetadata || typeof objectMetadata !== "object" || Array.isArray(objectMetadata)) {
    return { valid: false, reason: "missing_metadata" };
  }
  if (objectMetadata.contentType !== binding.expectedContentType) {
    return { valid: false, reason: "wrong_content_type" };
  }
  if (!/^[1-9][0-9]*$/.test(String(objectMetadata.size ?? "")) || Number(objectMetadata.size) < 5) {
    return { valid: false, reason: "invalid_size" };
  }
  if (!/^[1-9][0-9]*$/.test(String(objectMetadata.generation ?? ""))) {
    return { valid: false, reason: "invalid_generation" };
  }
  const expected = extractionArtifactMetadata(binding);
  const actual = objectMetadata.metadata;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return { valid: false, reason: "missing_binding_metadata" };
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) return { valid: false, reason: `binding_mismatch:${key}` };
  }
  return {
    valid: true,
    generation: String(objectMetadata.generation),
    etag: typeof objectMetadata.etag === "string" ? objectMetadata.etag : null,
    bytes: Number(objectMetadata.size),
  };
}
