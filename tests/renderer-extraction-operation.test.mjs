import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
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
} from "../services/renderer/extraction-operation.mjs";
import { extractLastFrameV2 } from "../services/renderer/server.mjs";

function fixture() {
  const generationJobId = "job_123";
  return buildExtractionBinding({
    operationId: expectedExtractionOperationId(generationJobId),
    projectId: "prj_123",
    sceneId: "scene_123",
    generationJobId,
    videoUri: "gs://veo-output/video.mp4",
    outputGcsUri: "gs://render-output/projects/prj_123/frames/scene_123-job_123-last.jpg",
  });
}

test("renderer v2 derives stable operation and durable record paths", () => {
  assert.equal(expectedExtractionOperationId("job_123"), "extract-last-frame:v1:job_123");
  assert.equal(
    extractionOperationObject(
      "projects/prj_123/frames/scene_123-job_123-last.jpg",
      "prj_123",
      "scene_123",
      "job_123",
    ),
    ".veo3flow/operations/extract-last-frame/job_123.json",
  );
  assert.equal(
    extractionOperationObject(
      "tenant-a/projects/prj_123/frames/scene_123-job_123-last.jpg",
      "prj_123",
      "scene_123",
      "job_123",
    ),
    "tenant-a/.veo3flow/operations/extract-last-frame/job_123.json",
  );
  assert.equal(
    extractionOperationObject(
      "tenant/projects/archive/projects/prj_1/frames/scene_1-job_1-last.jpg",
      "prj_1",
      "scene_1",
      "job_1",
    ),
    "tenant/projects/archive/.veo3flow/operations/extract-last-frame/job_1.json",
  );
});

test("same binding is processing while active and becomes eligible only after expiry", () => {
  const binding = fixture();
  const record = createProcessingRecord(binding, "owner-a", 1_000, 10_000);

  assert.equal(classifyOperationRecord(record, binding, 10_999), "processing");
  assert.equal(classifyOperationRecord(record, binding, 11_000), "expired");
});

test("same operation id with different binding is an idempotency conflict", () => {
  const binding = fixture();
  const record = createProcessingRecord(binding, "owner-a", 1_000, 10_000);
  const conflicting = { ...binding, videoUri: "gs://veo-output/different.mp4" };

  assert.equal(classifyOperationRecord(record, conflicting, 2_000), "conflict");
});

test("takeover fences the previous owner and increments attempt", () => {
  const binding = fixture();
  const record = createProcessingRecord(binding, "owner-a", 1_000, 10_000);
  const takeover = takeOverProcessingRecord(record, "owner-b", 12_000, 10_000);

  assert.equal(takeover.ownerToken, "owner-b");
  assert.equal(takeover.attempt, 2);
  assert.equal(completeProcessingRecord(takeover, "owner-a", {}, 12_001), null);
  assert.equal(failProcessingRecord(takeover, "owner-a", "failure", 12_001), null);
});

test("completed and failed records replay their durable terminal states", () => {
  const binding = fixture();
  const record = createProcessingRecord(binding, "owner-a", 1_000, 10_000);
  const completed = completeProcessingRecord(
    record,
    "owner-a",
    { generation: "7", bytes: 100 },
    2_000,
  );
  const failed = failProcessingRecord(record, "owner-a", "end_frame_extraction_failed", 2_000);

  assert.equal(classifyOperationRecord(completed, binding, 50_000), "completed");
  assert.equal(classifyOperationRecord(failed, binding, 50_000), "failed");
  assert.equal(completed.ownerToken, null);
  assert.equal(failed.errorCode, "end_frame_extraction_failed");
});

test("artifact validation requires content, generation, size and exact binding metadata", () => {
  const binding = fixture();
  const object = {
    contentType: "image/jpeg",
    size: "128",
    generation: "42",
    etag: "etag-42",
    metadata: extractionArtifactMetadata(binding),
  };

  assert.deepEqual(validateExtractionArtifactMetadata(object, binding), {
    valid: true,
    generation: "42",
    etag: "etag-42",
    bytes: 128,
  });
  assert.equal(
    validateExtractionArtifactMetadata(
      { ...object, metadata: { ...object.metadata, "veo3flow-scene-id": "scene_other" } },
      binding,
    ).valid,
    false,
  );
  assert.equal(
    validateExtractionArtifactMetadata({ ...object, contentType: "text/plain" }, binding).reason,
    "wrong_content_type",
  );
  assert.equal(validateExtractionArtifactMetadata({ ...object, size: "0" }, binding).valid, false);
  assert.equal(validateExtractionArtifactMetadata({ ...object, generation: "" }, binding).valid, false);
});

test("artifact validation rejects missing metadata and every authoritative binding mismatch", () => {
  const binding = fixture();
  const valid = {
    contentType: "image/jpeg",
    size: "128",
    generation: "42",
    metadata: extractionArtifactMetadata(binding),
  };

  assert.equal(validateExtractionArtifactMetadata({ ...valid, metadata: null }, binding).valid, false);
  for (const key of [
    "veo3flow-project-id",
    "veo3flow-scene-id",
    "veo3flow-job-id",
    "veo3flow-operation-id",
    "veo3flow-artifact-kind",
    "veo3flow-request-version",
    "veo3flow-input-uri-sha256",
  ]) {
    const metadata = { ...valid.metadata, [key]: "wrong-binding" };
    assert.equal(
      validateExtractionArtifactMetadata({ ...valid, metadata }, binding).valid,
      false,
      `${key} must be authoritative`,
    );
  }
});

test("artifact validation rejects empty, malformed, partial-looking metadata", () => {
  const binding = fixture();
  const metadata = extractionArtifactMetadata(binding);
  const base = { contentType: "image/jpeg", size: "128", generation: "42", metadata };

  for (const size of [undefined, "", "0", "4", "-1", "12.5", "NaN"]) {
    assert.equal(validateExtractionArtifactMetadata({ ...base, size }, binding).valid, false);
  }
  for (const generation of [undefined, "", "0", "-1", "1.5", "not-a-generation"]) {
    assert.equal(validateExtractionArtifactMetadata({ ...base, generation }, binding).valid, false);
  }
});

test("production renderer concurrency elects one claim and invokes FFmpeg once", async () => {
  const ffmpegStarted = deferred();
  const releaseFfmpeg = deferred();
  const operationStore = createOperationStore();
  const counters = { ffmpeg: 0, uploads: 0 };
  let artifact = null;
  let tokenIndex = 0;
  const dependencies = {
    now: () => 1_000,
    createOwnerToken: () => `owner-${++tokenIndex}`,
    leaseDurationMs: 10_000,
    ...operationStore.dependencies,
    inspectExtractionArtifact: async () =>
      artifact ?? { exists: false, valid: false, reason: "missing" },
    downloadInput: async (_source, destination) => {
      await writeFile(destination, Buffer.from("test-video"));
    },
    runCommand: async (command, args) => {
      if (command === "ffprobe") return validProbe();
      assert.equal(command, "ffmpeg");
      counters.ffmpeg += 1;
      ffmpegStarted.resolve();
      await releaseFfmpeg.promise;
      await writeFile(args.at(-1), validJpeg());
      return { stdout: "", stderr: "" };
    },
    uploadExtractionArtifact: async () => {
      counters.uploads += 1;
      artifact = validArtifact();
    },
  };

  const concurrentRequests = [
    invokeExtractionV2(dependencies, "request-a"),
    invokeExtractionV2(dependencies, "request-b"),
  ];
  const loser = await Promise.race(concurrentRequests);
  await ffmpegStarted.promise;

  assert.equal(concurrentRequests.length, 2);
  assert.equal(loser.status, 202);
  assert.equal(loser.body.state, "processing");
  assert.equal(operationStore.counts.createWinners, 1);
  assert.equal(operationStore.counts.preconditionFailures, 1);
  assert.equal(counters.ffmpeg, 1);

  releaseFfmpeg.resolve();
  const completedRequests = await Promise.all(concurrentRequests);
  const winner = completedRequests.find((result) => result.status === 201);
  assert.ok(winner);
  assert.equal(winner.status, 201);
  assert.equal(winner.body.state, "completed");
  assert.equal(winner.body.disposition, "created");

  const replay = await invokeExtractionV2(dependencies, "request-replay");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.state, "completed");
  assert.equal(replay.body.disposition, "replayed");
  assert.equal(operationStore.counts.createWinners, 1);
  assert.equal(operationStore.counts.terminalWrites, 1);
  assert.equal(counters.ffmpeg, 1);
  assert.equal(counters.uploads, 1);
});

test("production renderer takeover reuses the artifact and fences the stale owner", async () => {
  const artifactPublished = deferred();
  const releaseStaleUpload = deferred();
  const operationStore = createOperationStore();
  const counters = { ffmpeg: 0, uploads: 0 };
  let artifact = null;
  let nowMs = 1_000;
  let tokenIndex = 0;
  const dependencies = {
    now: () => nowMs,
    createOwnerToken: () => `owner-${++tokenIndex}`,
    leaseDurationMs: 100,
    ...operationStore.dependencies,
    inspectExtractionArtifact: async () =>
      artifact ?? { exists: false, valid: false, reason: "missing" },
    downloadInput: async (_source, destination) => {
      await writeFile(destination, Buffer.from("test-video"));
    },
    runCommand: async (command, args) => {
      if (command === "ffprobe") return validProbe();
      assert.equal(command, "ffmpeg");
      counters.ffmpeg += 1;
      await writeFile(args.at(-1), validJpeg());
      return { stdout: "", stderr: "" };
    },
    uploadExtractionArtifact: async () => {
      counters.uploads += 1;
      artifact = validArtifact();
      artifactPublished.resolve();
      await releaseStaleUpload.promise;
    },
  };

  const staleRequest = invokeExtractionV2(dependencies, "request-stale");
  await artifactPublished.promise;
  nowMs = 1_101;

  const takeover = await invokeExtractionV2(dependencies, "request-takeover");
  assert.equal(takeover.status, 200);
  assert.equal(takeover.body.state, "completed");
  assert.equal(takeover.body.disposition, "reconciled");
  assert.equal(operationStore.counts.createWinners, 1);
  assert.equal(operationStore.counts.takeoverWinners, 1);
  assert.equal(operationStore.counts.terminalWrites, 1);
  assert.equal(counters.ffmpeg, 1);
  assert.equal(counters.uploads, 1);

  releaseStaleUpload.resolve();
  await assert.rejects(staleRequest, (error) => {
    assert.equal(error.code, "renderer_temporarily_unavailable");
    return true;
  });
  assert.equal(operationStore.current().record.state, "completed");
  assert.equal(operationStore.counts.terminalWrites, 1);
  assert.equal(counters.ffmpeg, 1);
});

test("production renderer fails closed on an existing invalid artifact", async () => {
  const operationStore = createOperationStore();
  const counters = { downloads: 0, commands: 0, uploads: 0 };
  const result = await invokeExtractionV2(
    {
      now: () => 1_000,
      createOwnerToken: () => "owner-invalid",
      leaseDurationMs: 10_000,
      ...operationStore.dependencies,
      inspectExtractionArtifact: async () => ({
        exists: true,
        valid: false,
        reason: "invalid_jpeg_magic",
      }),
      downloadInput: async () => {
        counters.downloads += 1;
      },
      runCommand: async () => {
        counters.commands += 1;
        return validProbe();
      },
      uploadExtractionArtifact: async () => {
        counters.uploads += 1;
      },
    },
    "request-invalid",
  );

  assert.equal(result.status, 422);
  assert.equal(result.body.state, "failed");
  assert.equal(operationStore.current().record.state, "failed");
  assert.deepEqual(counters, { downloads: 0, commands: 0, uploads: 0 });
});

function extractionRequest() {
  return {
    requestVersion: 1,
    operationId: "extract-last-frame:v1:job_123",
    projectId: "prj_123",
    sceneId: "scene_123",
    generationJobId: "job_123",
    videoUri: "gs://veo-output/video.mp4",
    format: "jpeg",
    expectedContentType: "image/jpeg",
    outputGcsUri:
      "gs://render-output/projects/prj_123/frames/scene_123-job_123-last.jpg",
  };
}

async function invokeExtractionV2(dependencies, requestId) {
  const response = captureResponse();
  await extractLastFrameV2(extractionRequest(), requestId, response, dependencies);
  return response.result();
}

function captureResponse() {
  let headersSent = false;
  let status = null;
  let body = null;
  return {
    get headersSent() {
      return headersSent;
    },
    writeHead(nextStatus) {
      headersSent = true;
      status = nextStatus;
    },
    end(value) {
      body = JSON.parse(String(value));
    },
    result() {
      return { status, body };
    },
  };
}

function createOperationStore() {
  let stored = null;
  let generation = 0;
  const counts = {
    createWinners: 0,
    takeoverWinners: 0,
    terminalWrites: 0,
    preconditionFailures: 0,
  };
  return {
    counts,
    dependencies: {
      readOperationRecord: async () =>
        stored
          ? { record: structuredClone(stored), generation: String(generation) }
          : null,
      writeOperationRecord: async (_location, record, expectedGeneration) => {
        const expected = Number(expectedGeneration);
        if ((expected === 0 && stored) || (expected !== 0 && expected !== generation)) {
          counts.preconditionFailures += 1;
          return { preconditionFailed: true };
        }
        generation += 1;
        stored = structuredClone(record);
        if (expected === 0) counts.createWinners += 1;
        if (record.state === "processing" && record.attempt > 1) {
          counts.takeoverWinners += 1;
        }
        if (record.state === "completed" || record.state === "failed") {
          counts.terminalWrites += 1;
        }
        return { preconditionFailed: false, generation: String(generation) };
      },
    },
    current() {
      return stored
        ? { record: structuredClone(stored), generation: String(generation) }
        : null;
    },
  };
}

function validProbe() {
  return {
    stdout: JSON.stringify({
      streams: [{ codec_type: "video", width: 1920, height: 1080, duration: "4" }],
      format: { duration: "4" },
    }),
    stderr: "",
  };
}

function validArtifact() {
  return {
    exists: true,
    valid: true,
    generation: "7",
    etag: "etag-7",
    bytes: 6,
  };
}

function validJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
