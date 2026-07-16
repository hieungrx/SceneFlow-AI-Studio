import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  EXTRACTION_REQUEST_VERSION,
  buildExtractionBinding,
  classifyOperationRecord,
  completeProcessingRecord,
  createProcessingRecord,
  expectedExtractionOperationId,
  extractionArtifactMetadata,
  extractionOperationObject,
  failProcessingRecord,
  takeOverProcessingRecord,
  validateExtractionArtifactMetadata,
} from "./extraction-operation.mjs";

const PORT = integerFromEnv("PORT", 8080, 1, 65_535);
const AUTH_TOKEN = process.env.RENDERER_AUTH_TOKEN ?? "";
const MAX_BODY_BYTES = integerFromEnv("MAX_BODY_BYTES", 1_048_576, 1_024, 10_485_760);
const MAX_CLIPS = integerFromEnv("MAX_CLIPS", 100, 1, 100);
const MAX_INPUT_BYTES = integerFromEnv(
  "MAX_INPUT_BYTES",
  536_870_912,
  1_048_576,
  10_737_418_240,
);
const MAX_TOTAL_INPUT_BYTES = integerFromEnv(
  "MAX_TOTAL_INPUT_BYTES",
  4_294_967_296,
  MAX_INPUT_BYTES,
  21_474_836_480,
);
const COMMAND_TIMEOUT_MS = integerFromEnv(
  "FFMPEG_TIMEOUT_MS",
  900_000,
  10_000,
  3_600_000,
);
const DOWNLOAD_TIMEOUT_MS = integerFromEnv(
  "DOWNLOAD_TIMEOUT_MS",
  120_000,
  1_000,
  900_000,
);
const EXTRACTION_HARD_TIMEOUT_MS = integerFromEnv(
  "EXTRACTION_HARD_TIMEOUT_MS",
  1_200_000,
  60_000,
  3_300_000,
);
const EXTRACTION_OPERATION_LEASE_MARGIN_MS = 300_000;
const EXTRACTION_OPERATION_LEASE_MS =
  EXTRACTION_HARD_TIMEOUT_MS + EXTRACTION_OPERATION_LEASE_MARGIN_MS;
const MAX_CONCURRENT_JOBS = integerFromEnv("MAX_CONCURRENT_JOBS", 2, 1, 32);
const MAX_LOG_BYTES = 65_536;
const VIDEO_PRESETS = new Set([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
]);
const XFADE_TRANSITIONS = new Set([
  "fade",
  "fadeblack",
  "fadewhite",
  "dissolve",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
]);
const BLOCKED_UPLOAD_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

let activeJobs = 0;
let cachedGcsToken = null;
let runningServer = null;

const IS_MAIN_MODULE =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

class CommandError extends Error {
  constructor(command, exitCode, stderr) {
    super(`${command} exited with code ${exitCode}`);
    this.name = "CommandError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function createRendererServer() {
  const server = createServer(async (request, response) => {
    const requestId = getRequestId(request);
    setResponseHeaders(response, requestId);

    try {
      const url = new URL(request.url ?? "/", "http://renderer.local");

      if (
        request.method === "GET" &&
        (url.pathname === "/health" || url.pathname === "/healthz" || url.pathname === "/healthz/")
      ) {
        sendJson(response, 200, {
          ok: true,
          service: "sceneflow-renderer",
          activeJobs,
          capacity: MAX_CONCURRENT_JOBS,
        });
        return;
      }

      if (request.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Only POST is allowed for this endpoint.");
      }

      authenticate(request);
      const body = await readJsonBody(request);

      if (url.pathname === "/extract-last-frame") {
        await withJobSlot(() => extractLastFrame(body, requestId, response));
        return;
      }

      if (url.pathname === "/render") {
        await withJobSlot(() => renderVideo(body, requestId, response));
        return;
      }

      throw new HttpError(404, "not_found", "Endpoint not found.");
    } catch (error) {
      handleError(error, requestId, response);
    }
  });

  server.requestTimeout = Math.max(
    COMMAND_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS + 30_000,
    EXTRACTION_HARD_TIMEOUT_MS + 30_000,
  );
  server.headersTimeout = 30_000;
  return server;
}

function startRendererServer() {
  if (!AUTH_TOKEN) {
    console.error("RENDERER_AUTH_TOKEN is required; refusing to start an unprotected renderer.");
    process.exit(1);
  }
  if (Buffer.byteLength(AUTH_TOKEN) < 24) {
    console.warn("RENDERER_AUTH_TOKEN is shorter than the recommended 24 bytes.");
  }
  const server = createRendererServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "renderer_started", port: PORT }));
  });
  return server;
}

if (IS_MAIN_MODULE) runningServer = startRendererServer();

function integerFromEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    console.error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    process.exit(1);
  }
  return parsed;
}

function getRequestId(request) {
  const supplied = request.headers["x-request-id"];
  if (typeof supplied === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(supplied)) {
    return supplied;
  }
  return randomUUID();
}

function setResponseHeaders(response, requestId) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-request-id", requestId);
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  const json = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
}

function authenticate(request) {
  const rendererToken = request.headers["x-renderer-token"];
  const authorization = request.headers.authorization;
  const candidate =
    typeof rendererToken === "string"
      ? rendererToken
      : typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

  const expectedBuffer = Buffer.from(AUTH_TOKEN);
  const candidateBuffer = Buffer.from(candidate);
  const valid =
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer);

  if (!valid) {
    throw new HttpError(401, "unauthorized", "A valid renderer token is required.");
  }
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "JSON payload is too large.");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "JSON payload is too large.");
    }
    chunks.push(chunk);
  }

  if (total === 0) {
    throw new HttpError(400, "empty_body", "A JSON body is required.");
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return assertObject(body, "body");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

async function withJobSlot(task) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    throw new HttpError(429, "renderer_busy", "Renderer capacity is full; retry later.");
  }

  activeJobs += 1;
  try {
    return await task();
  } finally {
    activeJobs -= 1;
  }
}

async function extractLastFrame(body, requestId, response) {
  if (isExtractionV2Request(body)) {
    await extractLastFrameV2(body, requestId, response);
    return;
  }
  await extractLastFrameLegacy(body, requestId, response);
}

function isExtractionV2Request(body) {
  return [
    "requestVersion",
    "operationId",
    "projectId",
    "sceneId",
    "generationJobId",
    "expectedContentType",
  ].some((field) => body[field] !== undefined);
}

function parseExtractionV2Request(body) {
  if (body.requestVersion !== EXTRACTION_REQUEST_VERSION) {
    throw new HttpError(400, "invalid_request_version", "requestVersion must be 1.");
  }
  const projectId = requiredOperationIdentifier(body.projectId, "projectId");
  const sceneId = requiredOperationIdentifier(body.sceneId, "sceneId");
  const generationJobId = requiredOperationIdentifier(body.generationJobId, "generationJobId");
  const expectedOperationId = expectedExtractionOperationId(generationJobId);
  if (body.operationId !== expectedOperationId) {
    throw new HttpError(
      400,
      "invalid_operation_binding",
      "operationId does not match generationJobId.",
    );
  }
  if (body.format !== undefined && body.format !== "jpeg") {
    throw new HttpError(400, "invalid_operation_binding", "Contract v2 only supports JPEG output.");
  }
  if (body.expectedContentType !== "image/jpeg") {
    throw new HttpError(
      400,
      "invalid_operation_binding",
      "expectedContentType must be image/jpeg.",
    );
  }
  if (body.outputUpload !== undefined) {
    throw new HttpError(
      400,
      "invalid_operation_binding",
      "Contract v2 requires outputGcsUri for durable idempotency.",
    );
  }
  if (typeof body.videoUri !== "string") {
    throw new HttpError(400, "invalid_operation_binding", "Contract v2 requires videoUri.");
  }
  const source = parseInputUri(body.videoUri, "videoUri");
  const output = parseGcsUri(body.outputGcsUri, "outputGcsUri");
  const expectedSuffix = `projects/${projectId}/frames/${sceneId}-${generationJobId}-last.jpg`;
  if (output.object !== expectedSuffix && !output.object.endsWith(`/${expectedSuffix}`)) {
    throw new HttpError(
      400,
      "invalid_operation_binding",
      "outputGcsUri is not the deterministic continuity-frame path for this operation.",
    );
  }
  const outputGcsUri = `gs://${output.bucket}/${output.object}`;
  const binding = buildExtractionBinding({
    operationId: body.operationId,
    projectId,
    sceneId,
    generationJobId,
    videoUri: body.videoUri,
    outputGcsUri,
  });
  return {
    binding,
    source,
    output,
    operationLocation: {
      kind: "gcs",
      bucket: output.bucket,
      object: extractionOperationObject(output.object, projectId, sceneId, generationJobId),
    },
  };
}

function requiredOperationIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_operation_binding",
      `${field} must contain 1-128 safe identifier characters.`,
    );
  }
  return value;
}

function resolveExtractionDependencies(overrides = {}) {
  return {
    now: () => Date.now(),
    createOwnerToken: () => randomUUID(),
    leaseDurationMs: EXTRACTION_OPERATION_LEASE_MS,
    readOperationRecord,
    writeOperationRecord,
    inspectExtractionArtifact,
    uploadExtractionArtifact,
    downloadInput,
    runCommand,
    ...overrides,
  };
}

export async function extractLastFrameV2(body, requestId, response, overrides = {}) {
  const request = parseExtractionV2Request(body);
  const dependencies = resolveExtractionDependencies(overrides);
  const deadline = createOperationDeadline(EXTRACTION_HARD_TIMEOUT_MS);
  let claim;
  try {
    claim = await claimExtractionOperation(request, deadline, dependencies);
    if (claim.outcome === "processing") {
      sendJson(response, 202, {
        ok: true,
        requestId,
        operation: "extract-last-frame",
        requestVersion: EXTRACTION_REQUEST_VERSION,
        operationId: request.binding.operationId,
        state: "processing",
        retryAfterMs: Math.max(1_000, Math.min(30_000, claim.retryAfterMs)),
      });
      return;
    }
    if (claim.outcome === "failed") {
      sendExtractionFailure(response, requestId, request.binding.operationId, claim.errorCode);
      return;
    }
    if (claim.outcome === "completed") {
      const artifact = await dependencies.inspectExtractionArtifact(request, deadline);
      const recordedGeneration = String(claim.record.output?.generation ?? "");
      if (!artifact.valid || artifact.generation !== recordedGeneration) {
        const persisted = await persistCompletedArtifactFailure(
          request,
          claim,
          deadline,
          dependencies,
        );
        if (!persisted) {
          throw new HttpError(
            503,
            "renderer_temporarily_unavailable",
            "Completed extraction artifact could not be reconciled authoritatively.",
          );
        }
        sendExtractionFailure(
          response,
          requestId,
          request.binding.operationId,
          "end_frame_extraction_failed",
        );
        return;
      }
      sendExtractionSuccess(
        response,
        200,
        requestId,
        request.binding,
        claim.record.output,
        artifact,
        "replayed",
      );
      return;
    }

    await executeClaimedExtraction(
      request,
      claim,
      deadline,
      requestId,
      response,
      dependencies,
    );
  } finally {
    deadline.dispose();
  }
}

async function claimExtractionOperation(request, deadline, dependencies) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    deadline.assertActive();
    const stored = await dependencies.readOperationRecord(request.operationLocation, deadline);
    if (!stored) {
      const ownerToken = dependencies.createOwnerToken();
      const record = createProcessingRecord(
        request.binding,
        ownerToken,
        dependencies.now(),
        dependencies.leaseDurationMs,
      );
      const created = await dependencies.writeOperationRecord(
        request.operationLocation,
        record,
        0,
        deadline,
      );
      if (created.preconditionFailed) continue;
      return {
        outcome: "claimed",
        disposition: "created",
        ownerToken,
        record,
        generation: created.generation,
      };
    }

    const classification = classifyOperationRecord(
      stored.record,
      request.binding,
      dependencies.now(),
    );
    if (classification === "conflict") {
      throw new HttpError(
        409,
        "idempotency_conflict",
        "operationId is already bound to different extraction inputs.",
      );
    }
    if (classification === "invalid") {
      throw new HttpError(409, "operation_record_invalid", "The durable operation record is invalid.");
    }
    if (classification === "completed") {
      return { outcome: "completed", record: stored.record, generation: stored.generation };
    }
    if (classification === "failed") {
      return {
        outcome: "failed",
        errorCode: stored.record.errorCode ?? "end_frame_extraction_failed",
      };
    }
    if (classification === "processing") {
      return {
        outcome: "processing",
        retryAfterMs: Date.parse(stored.record.leaseExpiresAt) - dependencies.now(),
      };
    }

    const existingArtifact = await dependencies.inspectExtractionArtifact(request, deadline);
    const ownerToken = dependencies.createOwnerToken();
    const takeover = takeOverProcessingRecord(
      stored.record,
      ownerToken,
      dependencies.now(),
      dependencies.leaseDurationMs,
    );
    const updated = await dependencies.writeOperationRecord(
      request.operationLocation,
      takeover,
      stored.generation,
      deadline,
    );
    if (updated.preconditionFailed) continue;
    return {
      outcome: "claimed",
      disposition: existingArtifact.valid ? "reconciled" : "created",
      ownerToken,
      record: takeover,
      generation: updated.generation,
      existingArtifact,
    };
  }
  throw new HttpError(
    503,
    "renderer_temporarily_unavailable",
    "The extraction operation changed too frequently; retry later.",
  );
}

async function executeClaimedExtraction(
  request,
  claim,
  deadline,
  requestId,
  response,
  dependencies,
) {
  let workdir;
  let artifactUploadAttempted = false;
  try {
    const existingArtifact =
      claim.existingArtifact ??
      (await dependencies.inspectExtractionArtifact(request, deadline));
    if (existingArtifact.exists && !existingArtifact.valid) {
      const persisted = await persistExtractionFailure(
        request,
        claim,
        deadline,
        dependencies,
      );
      if (!persisted) {
        throw new HttpError(
          503,
          "renderer_temporarily_unavailable",
          "Invalid extraction artifact could not be recorded authoritatively.",
        );
      }
      sendExtractionFailure(
        response,
        requestId,
        request.binding.operationId,
        "end_frame_extraction_failed",
      );
      return;
    }
    if (existingArtifact.valid) {
      const completed = await persistExtractionCompletion(
        request,
        claim,
        existingArtifact,
        existingArtifact.output ?? null,
        deadline,
        dependencies,
      );
      sendExtractionSuccess(
        response,
        200,
        requestId,
        request.binding,
        completed.output,
        existingArtifact,
        "reconciled",
      );
      return;
    }

    workdir = await mkdtemp(join(tmpdir(), "sceneflow-frame-v2-"));
    const inputPath = join(workdir, "input.media");
    const outputPath = join(workdir, "last-frame.jpg");
    await dependencies.downloadInput(request.source, inputPath, MAX_INPUT_BYTES, deadline);

    const sourceProbe = await probeMedia(inputPath, deadline, dependencies.runCommand);
    requireVideoStream(sourceProbe, "videoUri");
    await dependencies.runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-sseof",
        "-0.1",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-q:v",
        "2",
        outputPath,
      ],
      deadline,
    );

    const outputProbe = await probeMedia(outputPath, deadline, dependencies.runCommand);
    const videoStream = requireVideoStream(outputProbe, "rendered frame");
    await assertClaimOwner(request.operationLocation, claim, deadline, dependencies);
    artifactUploadAttempted = true;
    await dependencies.uploadExtractionArtifact(request, outputPath, deadline);
    const artifact = await dependencies.inspectExtractionArtifact(request, deadline);
    if (!artifact.valid) {
      throw new HttpError(
        422,
        "extraction_artifact_invalid",
        `Uploaded extraction artifact failed validation: ${artifact.reason}.`,
      );
    }
    const output = {
      contentType: "image/jpeg",
      bytes: artifact.bytes,
      width: videoStream.width,
      height: videoStream.height,
      durationSeconds: mediaDuration(sourceProbe),
      generation: artifact.generation,
      etag: artifact.etag,
    };
    const completed = await persistExtractionCompletion(
      request,
      claim,
      artifact,
      output,
      deadline,
      dependencies,
    );
    sendExtractionSuccess(
      response,
      claim.disposition === "created" ? 201 : 200,
      requestId,
      request.binding,
      completed.output,
      artifact,
      claim.disposition,
    );
  } catch (error) {
    const recovered = await tryRecoverUploadedArtifact(request, claim, dependencies);
    if (recovered) {
      sendExtractionSuccess(
        response,
        200,
        requestId,
        request.binding,
        recovered.output,
        recovered.artifact,
        "reconciled",
      );
      return;
    }
    if (isDurableExtractionFailure(error)) {
      const persisted = await persistExtractionFailureWithRecoveryDeadline(
        request,
        claim,
        dependencies,
      );
      if (persisted) {
        sendExtractionFailure(
          response,
          requestId,
          request.binding.operationId,
          "end_frame_extraction_failed",
        );
        return;
      }
    }
    if (!artifactUploadAttempted) {
      await expireClaimWithRecoveryDeadline(request, claim, dependencies);
    }
    throw new HttpError(
      503,
      "renderer_temporarily_unavailable",
      "The extraction outcome is not authoritative yet; retry the same operationId.",
    );
  } finally {
    if (workdir) await boundedCleanup(workdir);
  }
}

async function extractLastFrameLegacy(body, requestId, response) {
  const source = parseInputUri(body.videoUri ?? body.videoUrl, "videoUri");
  const upload = parseOutputDestination(body);
  const format = optionalEnum(body.format, "format", ["jpeg", "png"], "jpeg");
  const extension = format === "jpeg" ? "jpg" : "png";
  const contentType = format === "jpeg" ? "image/jpeg" : "image/png";
  const deadline = createOperationDeadline(EXTRACTION_HARD_TIMEOUT_MS);
  const workdir = await mkdtemp(join(tmpdir(), "sceneflow-frame-"));

  try {
    const inputPath = join(workdir, "input.media");
    const outputPath = join(workdir, `last-frame.${extension}`);
    await downloadInput(source, inputPath, MAX_INPUT_BYTES, deadline);

    const sourceProbe = await probeMedia(inputPath, deadline);
    requireVideoStream(sourceProbe, "videoUri");

    const formatArgs =
      format === "jpeg" ? ["-q:v", "2"] : ["-compression_level", "3"];
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-sseof",
      "-0.1",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      ...formatArgs,
      outputPath,
    ], deadline);

    const outputProbe = await probeMedia(outputPath, deadline);
    const videoStream = requireVideoStream(outputProbe, "rendered frame");
    const uploaded = await uploadFile(upload, outputPath, contentType, deadline);

    sendJson(response, 200, {
      ok: true,
      requestId,
      operation: "extract-last-frame",
      ...(uploaded.outputUri ? { outputUri: uploaded.outputUri } : {}),
      source: {
        durationSeconds: mediaDuration(sourceProbe),
      },
      output: {
        contentType,
        bytes: uploaded.bytes,
        width: videoStream.width,
        height: videoStream.height,
      },
    });
  } finally {
    deadline.dispose();
    await boundedCleanup(workdir);
  }
}

function createOperationDeadline(durationMs) {
  const controller = new AbortController();
  const expiresAt = Date.now() + durationMs;
  const timeout = setTimeout(() => {
    controller.abort(new Error("Extraction hard deadline exceeded."));
  }, durationMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    expiresAt,
    remainingMs() {
      return Math.max(0, expiresAt - Date.now());
    },
    assertActive() {
      if (controller.signal.aborted || Date.now() >= expiresAt) {
        throw new HttpError(
          504,
          "extraction_deadline_exceeded",
          "Extraction exceeded its hard execution deadline.",
        );
      }
    },
    dispose() {
      clearTimeout(timeout);
    },
  };
}

async function readOperationRecord(location, deadline) {
  const metadata = await getGcsObjectMetadata(location, deadline);
  if (!metadata) return null;
  if (!/^[1-9][0-9]*$/.test(String(metadata.generation ?? ""))) {
    throw new HttpError(502, "operation_record_invalid", "Operation record has no generation.");
  }
  const response = await readGcsObject(
    location,
    deadline,
    { generation: String(metadata.generation) },
    65_536,
  );
  if (response.status !== 200) {
    throw new HttpError(
      502,
      "operation_record_read_failed",
      `Operation record read returned HTTP ${response.status}.`,
    );
  }
  let record;
  try {
    record = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new HttpError(502, "operation_record_invalid", "Operation record is not valid JSON.");
  }
  return { record, generation: String(metadata.generation) };
}

async function writeOperationRecord(location, record, expectedGeneration, deadline) {
  deadline.assertActive();
  const accessToken = await getGcsAccessToken(deadline);
  const url = new URL(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(location.bucket)}/o`,
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", location.object);
  url.searchParams.set("ifGenerationMatch", String(expectedGeneration));
  const body = Buffer.from(JSON.stringify(record), "utf8");
  const response = await gcsRequest(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
      },
      body,
      maxResponseBytes: 65_536,
    },
    deadline,
  );
  if (response.status === 412) return { preconditionFailed: true };
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(
      502,
      "operation_record_write_failed",
      `Operation record write returned HTTP ${response.status}.`,
    );
  }
  const written = parseGcsJson(response.body, "operation record write");
  if (!/^[1-9][0-9]*$/.test(String(written.generation ?? ""))) {
    throw new HttpError(502, "operation_record_write_failed", "GCS omitted record generation.");
  }
  return { preconditionFailed: false, generation: String(written.generation) };
}

async function getGcsObjectMetadata(location, deadline) {
  deadline.assertActive();
  const accessToken = await getGcsAccessToken(deadline);
  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(location.bucket)}/o/${encodeURIComponent(location.object)}`,
  );
  const response = await gcsRequest(
    url,
    {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      maxResponseBytes: 65_536,
    },
    deadline,
  );
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(
      502,
      "gcs_metadata_read_failed",
      `GCS metadata read returned HTTP ${response.status}.`,
    );
  }
  return parseGcsJson(response.body, "GCS metadata read");
}

async function readGcsObject(location, deadline, options = {}, maxResponseBytes = 65_536) {
  deadline.assertActive();
  const accessToken = await getGcsAccessToken(deadline);
  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(location.bucket)}/o/${encodeURIComponent(location.object)}`,
  );
  url.searchParams.set("alt", "media");
  if (options.generation) url.searchParams.set("ifGenerationMatch", options.generation);
  return gcsRequest(
    url,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.range ? { range: options.range } : {}),
      },
      maxResponseBytes,
    },
    deadline,
  );
}

async function gcsRequest(url, options, deadline) {
  deadline.assertActive();
  const pinnedLookup = await createPinnedLookup(url, "GCS API", deadline);
  deadline.assertActive();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      deadline.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = httpsRequest(
      url,
      {
        method: options.method,
        headers: options.headers,
        lookup: pinnedLookup,
        timeout: Math.max(1, Math.min(DOWNLOAD_TIMEOUT_MS, deadline.remainingMs())),
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > options.maxResponseBytes) {
            response.destroy(new Error("GCS response exceeded its size limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(resolve, {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", (error) => finish(reject, gcsTransportError(error, deadline)));
      },
    );
    const onAbort = () => request.destroy(new Error("Extraction hard deadline exceeded."));
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy(new Error("GCS request timed out.")));
    request.on("error", (error) => finish(reject, gcsTransportError(error, deadline)));
    if (options.body) request.end(options.body);
    else request.end();
  });
}

function gcsTransportError(error, deadline) {
  if (deadline.signal.aborted || deadline.remainingMs() === 0) {
    return new HttpError(
      504,
      "extraction_deadline_exceeded",
      "Extraction exceeded its hard execution deadline.",
    );
  }
  return new HttpError(502, "gcs_request_failed", `GCS request failed: ${error.message}`);
}

function parseGcsJson(buffer, operation) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(502, "gcs_invalid_response", `${operation} returned invalid JSON.`);
  }
}

async function inspectExtractionArtifact(request, deadline) {
  const metadata = await getGcsObjectMetadata(request.output, deadline);
  if (!metadata) return { exists: false, valid: false, reason: "missing" };
  if (metadata.name !== request.output.object || metadata.bucket !== request.output.bucket) {
    return { exists: true, valid: false, reason: "wrong_object_identity" };
  }
  const validation = validateExtractionArtifactMetadata(metadata, request.binding);
  if (!validation.valid) return { exists: true, ...validation };
  const first = await readGcsObject(
    request.output,
    deadline,
    { generation: validation.generation, range: "bytes=0-2" },
    16,
  );
  const lastOffset = validation.bytes - 2;
  const last = await readGcsObject(
    request.output,
    deadline,
    {
      generation: validation.generation,
      range: `bytes=${lastOffset}-${validation.bytes - 1}`,
    },
    16,
  );
  if (![200, 206].includes(first.status) || ![200, 206].includes(last.status)) {
    return { exists: true, valid: false, reason: "magic_read_failed" };
  }
  if (
    first.body.length < 3 ||
    first.body[0] !== 0xff ||
    first.body[1] !== 0xd8 ||
    first.body[2] !== 0xff ||
    last.body.length < 2 ||
    last.body.at(-2) !== 0xff ||
    last.body.at(-1) !== 0xd9
  ) {
    return { exists: true, valid: false, reason: "invalid_jpeg_magic" };
  }
  return { exists: true, ...validation };
}

async function uploadExtractionArtifact(request, filePath, deadline) {
  deadline.assertActive();
  const fileStat = await stat(filePath);
  if (fileStat.size > 67_108_864) {
    throw new HttpError(422, "rendered_frame_too_large", "Rendered JPEG exceeds 64 MiB.");
  }
  const file = await readFile(filePath);
  if (
    file.length < 5 ||
    file[0] !== 0xff ||
    file[1] !== 0xd8 ||
    file[2] !== 0xff ||
    file.at(-2) !== 0xff ||
    file.at(-1) !== 0xd9
  ) {
    throw new HttpError(422, "invalid_rendered_frame", "FFmpeg output is not a complete JPEG.");
  }
  deadline.assertActive();
  const accessToken = await getGcsAccessToken(deadline);
  const boundary = `sceneflow-${randomUUID()}`;
  const objectMetadata = Buffer.from(
    JSON.stringify({
      name: request.output.object,
      contentType: "image/jpeg",
      metadata: extractionArtifactMetadata(request.binding),
    }),
    "utf8",
  );
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    "utf8",
  );
  const middle = Buffer.from(
    `\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([prefix, objectMetadata, middle, file, suffix]);
  const url = new URL(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(request.output.bucket)}/o`,
  );
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("ifGenerationMatch", "0");
  const response = await gcsRequest(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": `multipart/related; boundary=${boundary}`,
        "content-length": body.length,
      },
      body,
      maxResponseBytes: 65_536,
    },
    deadline,
  );
  if (response.status === 412) return;
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(
      502,
      "output_upload_failed",
      `Output upload returned HTTP ${response.status}.`,
    );
  }
}

async function assertClaimOwner(location, claim, deadline, dependencies) {
  const stored = await dependencies.readOperationRecord(location, deadline);
  if (
    !stored ||
    stored.record.state !== "processing" ||
    stored.record.ownerToken !== claim.ownerToken
  ) {
    throw new HttpError(409, "operation_fence_lost", "Extraction operation ownership was lost.");
  }
  return stored;
}

async function persistExtractionCompletion(
  request,
  claim,
  artifact,
  output,
  deadline,
  dependencies,
) {
  const stored = await assertClaimOwner(
    request.operationLocation,
    claim,
    deadline,
    dependencies,
  );
  const resolvedOutput = output ?? {
    contentType: "image/jpeg",
    bytes: artifact.bytes,
    width: null,
    height: null,
    durationSeconds: null,
    generation: artifact.generation,
    etag: artifact.etag,
  };
  const completed = completeProcessingRecord(
    stored.record,
    claim.ownerToken,
    resolvedOutput,
    dependencies.now(),
  );
  if (!completed) {
    throw new HttpError(409, "operation_fence_lost", "Extraction operation ownership was lost.");
  }
  const written = await dependencies.writeOperationRecord(
    request.operationLocation,
    completed,
    stored.generation,
    deadline,
  );
  if (written.preconditionFailed) {
    const authoritative = await dependencies.readOperationRecord(
      request.operationLocation,
      deadline,
    );
    if (authoritative?.record?.state === "completed") return authoritative.record;
    throw new HttpError(409, "operation_fence_lost", "Extraction operation ownership was lost.");
  }
  return completed;
}

async function persistExtractionFailure(request, claim, deadline, dependencies) {
  const stored = await assertClaimOwner(
    request.operationLocation,
    claim,
    deadline,
    dependencies,
  );
  const failed = failProcessingRecord(
    stored.record,
    claim.ownerToken,
    "end_frame_extraction_failed",
    dependencies.now(),
  );
  if (!failed) return false;
  const written = await dependencies.writeOperationRecord(
    request.operationLocation,
    failed,
    stored.generation,
    deadline,
  );
  return !written.preconditionFailed;
}

async function persistCompletedArtifactFailure(request, claim, deadline, dependencies) {
  const failed = {
    ...claim.record,
    state: "failed",
    ownerToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(dependencies.now()).toISOString(),
    output: null,
    errorCode: "end_frame_extraction_failed",
  };
  const written = await dependencies.writeOperationRecord(
    request.operationLocation,
    failed,
    claim.generation,
    deadline,
  );
  if (!written.preconditionFailed) return true;
  const authoritative = await dependencies.readOperationRecord(
    request.operationLocation,
    deadline,
  );
  return authoritative?.record?.state === "failed";
}

async function persistExtractionFailureWithRecoveryDeadline(request, claim, dependencies) {
  const recoveryDeadline = createOperationDeadline(15_000);
  try {
    return await persistExtractionFailure(request, claim, recoveryDeadline, dependencies);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "extraction_failure_record_write_failed",
        operationId: request.binding.operationId,
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    return false;
  } finally {
    recoveryDeadline.dispose();
  }
}

async function expireClaimWithRecoveryDeadline(request, claim, dependencies) {
  const recoveryDeadline = createOperationDeadline(15_000);
  try {
    const stored = await assertClaimOwner(
      request.operationLocation,
      claim,
      recoveryDeadline,
      dependencies,
    );
    const released = {
      ...stored.record,
      leaseExpiresAt: new Date(0).toISOString(),
      updatedAt: new Date(dependencies.now()).toISOString(),
    };
    await dependencies.writeOperationRecord(
      request.operationLocation,
      released,
      stored.generation,
      recoveryDeadline,
    );
  } catch {
    // Natural lease expiry remains the safe fallback if recovery coordination is unavailable.
  } finally {
    recoveryDeadline.dispose();
  }
}

async function tryRecoverUploadedArtifact(request, claim, dependencies) {
  const recoveryDeadline = createOperationDeadline(15_000);
  try {
    const artifact = await dependencies.inspectExtractionArtifact(request, recoveryDeadline);
    if (!artifact.valid) return null;
    const completed = await persistExtractionCompletion(
      request,
      claim,
      artifact,
      null,
      recoveryDeadline,
      dependencies,
    );
    return { artifact, output: completed.output };
  } catch {
    return null;
  } finally {
    recoveryDeadline.dispose();
  }
}

function isDurableExtractionFailure(error) {
  return (
    error instanceof CommandError ||
    (error instanceof HttpError && [400, 413, 422].includes(error.status))
  );
}

function sendExtractionSuccess(
  response,
  status,
  requestId,
  binding,
  output,
  artifact,
  disposition,
) {
  sendJson(response, status, {
    ok: true,
    requestId,
    operation: "extract-last-frame",
    requestVersion: EXTRACTION_REQUEST_VERSION,
    operationId: binding.operationId,
    state: "completed",
    disposition,
    outputUri: binding.outputGcsUri,
    source: { durationSeconds: output?.durationSeconds ?? null },
    output: {
      contentType: "image/jpeg",
      bytes: artifact.bytes,
      width: output?.width ?? null,
      height: output?.height ?? null,
      generation: artifact.generation,
      etag: artifact.etag,
    },
  });
}

function sendExtractionFailure(response, requestId, operationId, errorCode) {
  sendJson(response, 422, {
    ok: false,
    requestId,
    operation: "extract-last-frame",
    requestVersion: EXTRACTION_REQUEST_VERSION,
    operationId,
    state: "failed",
    error: {
      code: errorCode || "end_frame_extraction_failed",
      message: "The continuity frame could not be extracted.",
    },
  });
}

async function boundedCleanup(workdir) {
  let timeout;
  try {
    await Promise.race([
      rm(workdir, { recursive: true, force: true }),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 5_000);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function renderVideo(body, requestId, response) {
  if (!Array.isArray(body.clips) || body.clips.length < 1 || body.clips.length > MAX_CLIPS) {
    throw new HttpError(
      400,
      "invalid_clips",
      `clips must contain between 1 and ${MAX_CLIPS} items.`,
    );
  }

  const clips = body.clips.map((clip, index) => {
    if (typeof clip === "string") {
      return parseInputUri(clip, `clips[${index}].uri`);
    }
    const clipObject = assertObject(clip, `clips[${index}]`);
    return parseInputUri(clipObject.uri ?? clipObject.url, `clips[${index}].uri`);
  });
  const upload = parseOutputDestination(body);
  const width = optionalEvenInteger(body.width, "width", 1080, 256, 2160);
  const height = optionalEvenInteger(body.height, "height", 1920, 256, 3840);
  const fps = optionalInteger(body.fps, "fps", 24, 12, 60);
  const includeAudio = optionalBoolean(body.includeAudio, "includeAudio", true);
  const crf = optionalInteger(body.crf, "crf", 20, 16, 32);
  const preset = optionalEnum(body.preset, "preset", [...VIDEO_PRESETS], "veryfast");
  const transition = parseTransition(body.transition);
  const workdir = await mkdtemp(join(tmpdir(), "sceneflow-render-"));

  try {
    const downloadedPaths = [];
    let totalBytes = 0;

    for (let index = 0; index < clips.length; index += 1) {
      const inputPath = join(workdir, `input-${String(index).padStart(3, "0")}.media`);
      const downloaded = await downloadInput(clips[index], inputPath, MAX_INPUT_BYTES);
      totalBytes += downloaded.bytes;
      if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
        throw new HttpError(413, "inputs_too_large", "Combined clip inputs exceed the configured limit.");
      }
      downloadedPaths.push(inputPath);
    }

    const probes = [];
    for (let index = 0; index < downloadedPaths.length; index += 1) {
      const probe = await probeMedia(downloadedPaths[index]);
      requireVideoStream(probe, `clips[${index}]`);
      const duration = videoDuration(probe);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new HttpError(422, "invalid_media", `clips[${index}] has no usable duration.`);
      }
      probes.push(probe);
    }

    if (transition.durationSeconds > 0) {
      const shortestDuration = Math.min(...probes.map(videoDuration));
      if (transition.durationSeconds >= shortestDuration - 0.04) {
        throw new HttpError(
          400,
          "invalid_transition",
          "Transition duration must be shorter than every clip.",
        );
      }
    }

    const normalizedPaths = [];
    const durations = [];
    for (let index = 0; index < downloadedPaths.length; index += 1) {
      const normalizedPath = join(workdir, `normalized-${String(index).padStart(3, "0")}.mp4`);
      const duration = videoDuration(probes[index]);
      await normalizeClip({
        inputPath: downloadedPaths[index],
        outputPath: normalizedPath,
        probe: probes[index],
        duration,
        width,
        height,
        fps,
        includeAudio,
        crf,
        preset,
      });
      normalizedPaths.push(normalizedPath);
      durations.push(duration);
    }

    const outputPath = join(workdir, "rendered.mp4");
    await joinClips({
      inputPaths: normalizedPaths,
      durations,
      outputPath,
      includeAudio,
      transition,
      crf,
      preset,
    });

    const outputProbe = await probeMedia(outputPath);
    const outputVideo = requireVideoStream(outputProbe, "rendered video");
    const uploaded = await uploadFile(upload, outputPath, "video/mp4");

    sendJson(response, 200, {
      ok: true,
      requestId,
      operation: "render",
      ...(uploaded.outputUri ? { outputUri: uploaded.outputUri } : {}),
      clips: clips.length,
      transition,
      output: {
        contentType: "video/mp4",
        bytes: uploaded.bytes,
        durationSeconds: mediaDuration(outputProbe),
        width: outputVideo.width,
        height: outputVideo.height,
        fps,
        hasAudio: includeAudio,
      },
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function parseInputUri(raw, field) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 4_096) {
    throw new HttpError(400, "invalid_input_uri", `${field} must be a valid HTTPS or gs:// URI.`);
  }

  if (raw.startsWith("gs://")) {
    return parseGcsUri(raw, field);
  }

  return { kind: "https", url: assertHttpsUrl(raw, field).toString() };
}

function parseGcsUri(raw, field) {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > 4_096 ||
    raw.trim() !== raw
  ) {
    throw new HttpError(400, "invalid_gs_uri", `${field} must be a valid gs:// URI.`);
  }

  const match = /^gs:\/\/([^/]+)\/(.+)$/u.exec(raw);
  if (!match) {
    throw new HttpError(400, "invalid_gs_uri", `${field} must include a bucket and object.`);
  }
  const [, bucket, object] = match;
  validateGcsBucket(bucket, field);
  validateGcsObject(object, field);
  return { kind: "gcs", bucket, object };
}

function validateGcsBucket(bucket, field) {
  const components = bucket.split(".");
  const valid =
    bucket.length >= 3 &&
    bucket.length <= 222 &&
    /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(bucket) &&
    components.every(
      (component) =>
        component.length >= 1 &&
        component.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(component),
    ) &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket);
  if (!valid) {
    throw new HttpError(400, "invalid_gs_uri", `${field} contains an invalid GCS bucket name.`);
  }
}

function validateGcsObject(object, field) {
  const bytes = Buffer.byteLength(object, "utf8");
  const segments = object.split("/");
  const valid =
    bytes >= 1 &&
    bytes <= 1_024 &&
    !object.startsWith("/") &&
    !object.endsWith("/") &&
    !/[\u0000-\u001f\u007f\\]/.test(object) &&
    !segments.some((segment) => segment === "." || segment === "..");
  if (!valid) {
    throw new HttpError(400, "invalid_gs_uri", `${field} contains an invalid GCS object name.`);
  }
}

function assertHttpsUrl(raw, field) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_https_url", `${field} must be a valid HTTPS URL.`);
  }

  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new HttpError(400, "invalid_https_url", `${field} must be an HTTPS URL without credentials.`);
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    isPrivateIpLiteral(hostname)
  ) {
    throw new HttpError(400, "unsafe_https_url", `${field} may not target a local or private address.`);
  }
  return url;
}

function isPrivateIpLiteral(hostname) {
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split(".").map(Number);
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] <= 2) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || octets[1] === 51)) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
      octets[0] >= 224
    );
  }
  if (version === 6) {
    const value = hostname.toLowerCase();
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("::ffff:") ||
      value.startsWith("100:") ||
      value.startsWith("2001:db8:") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("ff")
    );
  }
  return false;
}

function parseOutputDestination(body) {
  const hasSignedUpload = body.outputUpload !== undefined;
  const hasGcsUri = body.outputGcsUri !== undefined;
  if (hasSignedUpload === hasGcsUri) {
    throw new HttpError(
      400,
      "invalid_output_destination",
      "Provide exactly one of outputUpload or outputGcsUri.",
    );
  }

  if (hasGcsUri) {
    return parseGcsUri(body.outputGcsUri, "outputGcsUri");
  }
  return parseUpload(body.outputUpload);
}

function parseUpload(raw) {
  const upload = assertObject(raw, "outputUpload");
  const url = assertHttpsUrl(upload.url, "outputUpload.url");
  const method = optionalEnum(upload.method, "outputUpload.method", ["PUT"], "PUT");
  const headers = parseUploadHeaders(upload.headers);
  return { kind: "https", url, method, headers };
}

function parseUploadHeaders(raw) {
  if (raw === undefined) return {};
  const headers = assertObject(raw, "outputUpload.headers");
  const entries = Object.entries(headers);
  if (entries.length > 30) {
    throw new HttpError(400, "invalid_upload_headers", "outputUpload.headers contains too many entries.");
  }

  const parsed = Object.create(null);
  for (const [name, value] of entries) {
    const lowerName = name.toLowerCase();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
      BLOCKED_UPLOAD_HEADERS.has(lowerName) ||
      typeof value !== "string" ||
      value.length > 4_096 ||
      /[\r\n]/.test(value)
    ) {
      throw new HttpError(400, "invalid_upload_headers", `Invalid upload header: ${name}.`);
    }
    parsed[lowerName] = value;
  }
  return parsed;
}

function parseTransition(raw) {
  if (raw === undefined) return { type: "cut", durationSeconds: 0 };
  const transition = assertObject(raw, "transition");
  const type = optionalEnum(
    transition.type,
    "transition.type",
    ["cut", ...XFADE_TRANSITIONS],
    "cut",
  );
  if (type === "cut") return { type, durationSeconds: 0 };
  const durationSeconds = optionalNumber(
    transition.durationSeconds,
    "transition.durationSeconds",
    0.2,
    0.05,
    2,
  );
  return { type, durationSeconds };
}

function assertObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be an object.`);
  }
  return value;
}

function optionalEnum(value, field, allowed, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, "invalid_payload", `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function optionalBoolean(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "invalid_payload", `${field} must be a boolean.`);
  }
  return value;
}

function optionalInteger(value, field, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_payload", `${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalEvenInteger(value, field, fallback, minimum, maximum) {
  const parsed = optionalInteger(value, field, fallback, minimum, maximum);
  if (parsed % 2 !== 0) {
    throw new HttpError(400, "invalid_payload", `${field} must be an even integer.`);
  }
  return parsed;
}

function optionalNumber(value, field, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_payload", `${field} must be from ${minimum} to ${maximum}.`);
  }
  return value;
}

async function downloadInput(source, destination, maxBytes, deadline) {
  deadline?.assertActive();
  if (source.kind === "https") {
    return downloadHttps(new URL(source.url), destination, maxBytes, {}, 0, true, deadline);
  }

  const accessToken = await getGcsAccessToken(deadline);
  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(source.bucket)}/o/${encodeURIComponent(source.object)}?alt=media`,
  );
  return downloadHttps(
    url,
    destination,
    maxBytes,
    { authorization: `Bearer ${accessToken}` },
    0,
    false,
    deadline,
  );
}

async function getGcsAccessToken(deadline) {
  deadline?.assertActive();
  const now = Date.now();
  if (cachedGcsToken && cachedGcsToken.expiresAt > now + 60_000) {
    return cachedGcsToken.value;
  }

  const override = process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (override) return override;

  const metadata = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      deadline?.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = httpRequest(
      {
        hostname: "metadata.google.internal",
        port: 80,
        method: "GET",
        path: "/computeMetadata/v1/instance/service-accounts/default/token",
        headers: { "metadata-flavor": "Google" },
        timeout: deadline ? Math.max(1, Math.min(3_000, deadline.remainingMs())) : 3_000,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= 32_768) chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200 || bytes > 32_768) {
            finish(reject, new Error(`Metadata server returned ${response.statusCode ?? "no status"}.`));
            return;
          }
          try {
            finish(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(reject, new Error("Metadata server returned invalid JSON."));
          }
        });
      },
    );
    const onAbort = () => request.destroy(new Error("Extraction hard deadline exceeded."));
    deadline?.signal.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy(new Error("Metadata token request timed out.")));
    request.on("error", (error) => finish(reject, error));
    request.end();
  }).catch((error) => {
    if (deadline?.signal.aborted) {
      throw new HttpError(
        504,
        "extraction_deadline_exceeded",
        "Extraction exceeded its hard execution deadline.",
      );
    }
    console.error(JSON.stringify({ event: "gcs_token_failed", message: error.message }));
    throw new HttpError(
      502,
      "gcs_auth_failed",
      "Unable to obtain Cloud Run service-account credentials for GCS access.",
    );
  });

  if (
    typeof metadata.access_token !== "string" ||
    !Number.isFinite(Number(metadata.expires_in))
  ) {
    throw new HttpError(502, "gcs_auth_failed", "Cloud credentials response is incomplete.");
  }

  cachedGcsToken = {
    value: metadata.access_token,
    expiresAt: now + Number(metadata.expires_in) * 1_000,
  };
  return cachedGcsToken.value;
}

async function downloadHttps(
  url,
  destination,
  maxBytes,
  headers,
  redirects,
  allowRedirects,
  deadline,
) {
  deadline?.assertActive();
  const pinnedLookup = await createPinnedLookup(url, "input URL", deadline);
  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      deadline?.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: { "user-agent": "sceneflow-renderer/0.1", ...headers },
        lookup: pinnedLookup,
        timeout: deadline
          ? Math.max(1, Math.min(DOWNLOAD_TIMEOUT_MS, deadline.remainingMs()))
          : DOWNLOAD_TIMEOUT_MS,
      },
      (incoming) => finish(resolve, incoming),
    );
    const onAbort = () => request.destroy(new Error("Extraction hard deadline exceeded."));
    deadline?.signal.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy(new Error("Input download timed out.")));
    request.on("error", (error) => finish(reject, error));
    request.end();
  }).catch((error) => {
    if (deadline?.signal.aborted) {
      throw new HttpError(
        504,
        "extraction_deadline_exceeded",
        "Extraction exceeded its hard execution deadline.",
      );
    }
    throw new HttpError(502, "input_download_failed", `Unable to download input: ${error.message}`);
  });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    if (!allowRedirects || redirects >= 3) {
      throw new HttpError(502, "input_redirect_rejected", "Input download redirect was rejected.");
    }
    const redirected = assertHttpsUrl(new URL(response.headers.location, url).toString(), "redirect URL");
    return downloadHttps(
      redirected,
      destination,
      maxBytes,
      headers,
      redirects + 1,
      true,
      deadline,
    );
  }

  if (response.statusCode !== 200) {
    response.resume();
    throw new HttpError(
      502,
      "input_download_failed",
      `Input server returned HTTP ${response.statusCode ?? "unknown"}.`,
    );
  }

  const declaredLength = Number(response.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy();
    throw new HttpError(413, "input_too_large", "An input file exceeds the configured limit.");
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new HttpError(413, "input_too_large", "An input file exceeds the configured limit."));
      } else {
        callback(null, chunk);
      }
    },
  });

  try {
    await pipeline(response, limiter, createWriteStream(destination, { flags: "wx" }), {
      ...(deadline ? { signal: deadline.signal } : {}),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (deadline?.signal.aborted) {
      throw new HttpError(
        504,
        "extraction_deadline_exceeded",
        "Extraction exceeded its hard execution deadline.",
      );
    }
    throw new HttpError(502, "input_download_failed", `Input download failed: ${error.message}`);
  }
  return { bytes };
}

async function uploadFile(upload, filePath, contentType, deadline) {
  deadline?.assertActive();
  const fileStat = await stat(filePath);
  let url;
  let method;
  let headers;
  let field;

  if (upload.kind === "gcs") {
    const accessToken = await getGcsAccessToken(deadline);
    url = new URL(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(upload.bucket)}/o`,
    );
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", upload.object);
    url.searchParams.set("ifGenerationMatch", "0");
    method = "POST";
    field = "outputGcsUri";
    headers = {
      authorization: `Bearer ${accessToken}`,
      "content-length": fileStat.size,
      "content-type": contentType,
    };
  } else {
    url = upload.url;
    method = upload.method;
    field = "outputUpload.url";
    headers = {
      "content-length": fileStat.size,
      "content-type": upload.headers["content-type"] ?? contentType,
      ...upload.headers,
    };
  }

  const pinnedLookup = await createPinnedLookup(url, field, deadline);
  deadline?.assertActive();

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      deadline?.signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = httpsRequest(
      url,
      {
        method,
        headers,
        lookup: pinnedLookup,
        timeout: deadline
          ? Math.max(1, Math.min(DOWNLOAD_TIMEOUT_MS, deadline.remainingMs()))
          : DOWNLOAD_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            finish(resolve);
          } else {
            finish(
              reject,
              new HttpError(
                502,
                "output_upload_failed",
                `Output upload returned HTTP ${response.statusCode ?? "unknown"}.`,
              ),
            );
          }
        });
      },
    );
    const onAbort = () => request.destroy(new Error("Extraction hard deadline exceeded."));
    deadline?.signal.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => request.destroy(new Error("Output upload timed out.")));
    request.on("error", (error) => {
      finish(
        reject,
        deadline?.signal.aborted
          ? new HttpError(
              504,
              "extraction_deadline_exceeded",
              "Extraction exceeded its hard execution deadline.",
            )
          : error instanceof HttpError
          ? error
          : new HttpError(502, "output_upload_failed", `Output upload failed: ${error.message}`),
      );
    });
    createReadStream(filePath).on("error", (error) => finish(reject, error)).pipe(request);
  });

  return {
    bytes: fileStat.size,
    outputUri: upload.kind === "gcs" ? `gs://${upload.bucket}/${upload.object}` : undefined,
  };
}

async function createPinnedLookup(url, field, deadline) {
  deadline?.assertActive();
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(hostname)) {
    if (isPrivateIpLiteral(hostname)) {
      throw new HttpError(400, "unsafe_https_url", `${field} may not target a private address.`);
    }
    const family = isIP(hostname);
    return (_requestedHost, options, callback) => {
      if (options?.all) callback(null, [{ address: hostname, family }]);
      else callback(null, hostname, family);
    };
  }

  let records;
  try {
    const lookupPromise = dnsLookup(hostname, { all: true, verbatim: true });
    records = deadline
      ? await Promise.race([
          lookupPromise,
          new Promise((_, reject) => {
            const onAbort = () =>
              reject(
                new HttpError(
                  504,
                  "extraction_deadline_exceeded",
                  "Extraction exceeded its hard execution deadline.",
                ),
              );
            deadline.signal.addEventListener("abort", onAbort, { once: true });
            lookupPromise.then(
              () => deadline.signal.removeEventListener("abort", onAbort),
              () => deadline.signal.removeEventListener("abort", onAbort),
            );
          }),
        ])
      : await lookupPromise;
  } catch {
    if (deadline?.signal.aborted) {
      throw new HttpError(
        504,
        "extraction_deadline_exceeded",
        "Extraction exceeded its hard execution deadline.",
      );
    }
    throw new HttpError(502, "dns_resolution_failed", `${field} hostname could not be resolved.`);
  }
  deadline?.assertActive();
  if (
    records.length === 0 ||
    records.some((record) => isPrivateIpLiteral(record.address))
  ) {
    throw new HttpError(400, "unsafe_https_url", `${field} resolved to a private or reserved address.`);
  }

  return (_requestedHost, options, callback) => {
    if (options?.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };
}

async function probeMedia(filePath, deadline, commandRunner = runCommand) {
  const { stdout } = await commandRunner("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ], deadline);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new HttpError(422, "invalid_media", "ffprobe could not read media metadata.");
  }
}

function requireVideoStream(probe, field) {
  const stream = Array.isArray(probe.streams)
    ? probe.streams.find((item) => item.codec_type === "video")
    : undefined;
  if (!stream) {
    throw new HttpError(422, "invalid_media", `${field} does not contain a video stream.`);
  }
  return stream;
}

function mediaDuration(probe) {
  const candidates = [
    Number(probe?.format?.duration),
    ...(Array.isArray(probe?.streams) ? probe.streams.map((stream) => Number(stream.duration)) : []),
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) return null;
  return Math.round(Math.max(...candidates) * 1_000) / 1_000;
}

function videoDuration(probe) {
  const videoStream = Array.isArray(probe?.streams)
    ? probe.streams.find((stream) => stream.codec_type === "video")
    : undefined;
  const candidates = [Number(videoStream?.duration), Number(probe?.format?.duration)].filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  return candidates.length > 0 ? Math.round(candidates[0] * 1_000) / 1_000 : null;
}

function hasAudioStream(probe) {
  return Array.isArray(probe.streams) && probe.streams.some((stream) => stream.codec_type === "audio");
}

function seconds(value) {
  return Number(value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

async function normalizeClip(options) {
  const {
    inputPath,
    outputPath,
    probe,
    duration,
    width,
    height,
    fps,
    includeAudio,
    crf,
    preset,
  } = options;
  const videoFilter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
    "setsar=1",
    "format=yuv420p",
    "setpts=PTS-STARTPTS",
  ].join(",");

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inputPath];
  const sourceHasAudio = hasAudioStream(probe);

  if (includeAudio && !sourceHasAudio) {
    args.push("-f", "lavfi", "-t", seconds(duration), "-i", "anullsrc=r=48000:cl=stereo");
  }

  args.push("-filter_complex", `[0:v:0]${videoFilter}[v]`, "-map", "[v]");
  if (includeAudio) {
    const audioInput = sourceHasAudio ? "0:a:0" : "1:a:0";
    args.push(
      "-map",
      audioInput,
      "-af",
      `aresample=48000:async=1:first_pts=0,aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${seconds(duration)},atrim=duration=${seconds(duration)},asetpts=PTS-STARTPTS`,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
    );
  } else {
    args.push("-an");
  }

  args.push(
    "-t",
    seconds(duration),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    outputPath,
  );
  await runCommand("ffmpeg", args);
}

async function joinClips(options) {
  const { inputPaths, durations, outputPath, includeAudio, transition, crf, preset } = options;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const inputPath of inputPaths) args.push("-i", inputPath);

  let filter;
  let videoOutput;
  let audioOutput;

  if (inputPaths.length === 1) {
    filter = includeAudio
      ? "[0:v:0]null[vout];[0:a:0]anull[aout]"
      : "[0:v:0]null[vout]";
    videoOutput = "[vout]";
    audioOutput = includeAudio ? "[aout]" : null;
  } else if (transition.durationSeconds === 0) {
    const inputs = inputPaths
      .map((_item, index) => (includeAudio ? `[${index}:v:0][${index}:a:0]` : `[${index}:v:0]`))
      .join("");
    filter = `${inputs}concat=n=${inputPaths.length}:v=1:a=${includeAudio ? 1 : 0}[vout]${includeAudio ? "[aout]" : ""}`;
    videoOutput = "[vout]";
    audioOutput = includeAudio ? "[aout]" : null;
  } else {
    const parts = [];
    for (let index = 0; index < inputPaths.length; index += 1) {
      parts.push(`[${index}:v:0]settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
      if (includeAudio) parts.push(`[${index}:a:0]asetpts=PTS-STARTPTS[a${index}]`);
    }

    let previousVideo = "v0";
    let previousAudio = "a0";
    let timeline = durations[0];
    for (let index = 1; index < inputPaths.length; index += 1) {
      const offset = timeline - transition.durationSeconds;
      const nextVideo = `vx${index}`;
      parts.push(
        `[${previousVideo}][v${index}]xfade=transition=${transition.type}:duration=${seconds(transition.durationSeconds)}:offset=${seconds(offset)}[${nextVideo}]`,
      );
      previousVideo = nextVideo;

      if (includeAudio) {
        const nextAudio = `ax${index}`;
        parts.push(
          `[${previousAudio}][a${index}]acrossfade=d=${seconds(transition.durationSeconds)}:c1=tri:c2=tri[${nextAudio}]`,
        );
        previousAudio = nextAudio;
      }
      timeline += durations[index] - transition.durationSeconds;
    }

    filter = parts.join(";");
    videoOutput = `[${previousVideo}]`;
    audioOutput = includeAudio ? `[${previousAudio}]` : null;
  }

  args.push("-filter_complex", filter, "-map", videoOutput);
  if (audioOutput) {
    args.push("-map", audioOutput, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-max_muxing_queue_size",
    "4096",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    outputPath,
  );
  await runCommand("ffmpeg", args);
}

async function runCommand(command, args, deadline) {
  deadline?.assertActive();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    let settled = false;

    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < MAX_LOG_BYTES) {
        stdout.push(chunk.subarray(0, MAX_LOG_BYTES - stdoutBytes));
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < MAX_LOG_BYTES) {
        stderr.push(chunk.subarray(0, MAX_LOG_BYTES - stderrBytes));
        stderrBytes += chunk.length;
      }
    });

    const killChildTree = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child kill.
        }
      }
      child.kill("SIGKILL");
    };
    const commandTimeout = Math.max(
      1,
      Math.min(COMMAND_TIMEOUT_MS, deadline?.remainingMs() ?? COMMAND_TIMEOUT_MS),
    );
    const timeout = setTimeout(() => {
      terminalError = deadline?.signal.aborted
        ? new HttpError(
            504,
            "extraction_deadline_exceeded",
            "Extraction exceeded its hard execution deadline.",
          )
        : new HttpError(504, "command_timeout", `${command} exceeded the execution timeout.`);
      killChildTree();
    }, commandTimeout);
    const onAbort = () => {
      terminalError = new HttpError(
        504,
        "extraction_deadline_exceeded",
        "Extraction exceeded its hard execution deadline.",
      );
      killChildTree();
    };
    deadline?.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      deadline?.signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HttpError(500, "command_unavailable", `${command} is not available: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (terminalError) {
        reject(terminalError);
      } else if (code === 0) {
        resolve({ stdout: output, stderr: errorOutput });
      } else {
        reject(new CommandError(command, code, errorOutput));
      }
    });
  });
}

function handleError(error, requestId, response) {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  if (error instanceof HttpError) {
    sendJson(response, error.status, {
      ok: false,
      requestId,
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof CommandError) {
    console.error(
      JSON.stringify({
        event: "media_command_failed",
        requestId,
        command: error.command,
        exitCode: error.exitCode,
        stderr: error.stderr,
      }),
    );
    sendJson(response, 422, {
      ok: false,
      requestId,
      error: { code: "media_processing_failed", message: "FFmpeg could not process the supplied media." },
    });
    return;
  }

  console.error(
    JSON.stringify({
      event: "renderer_error",
      requestId,
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  sendJson(response, 500, {
    ok: false,
    requestId,
    error: { code: "internal_error", message: "Unexpected renderer error." },
  });
}

function shutdown(signal) {
  console.log(JSON.stringify({ event: "renderer_shutdown", signal }));
  if (!runningServer) {
    process.exit(0);
  }
  runningServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

if (IS_MAIN_MODULE) {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
