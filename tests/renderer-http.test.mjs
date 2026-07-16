import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import {
  callRendererHttp,
  RendererRequestError,
} from "../lib/renderer-http.ts";

const testRuntimeEnv = {
  GOOGLE_ACCESS_TOKEN: "test-gcs-token",
  RENDER_SERVICE_URL: "https://renderer.example",
  RENDER_SERVICE_SECRET: "renderer-secret",
  RENDER_OUTPUT_GCS_URI: "gs://render-output/tenant",
};
globalThis.__SCENEFLOW_TEST_CLOUDFLARE_ENV = testRuntimeEnv;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "sceneflow-test:cloudflare-workers", shortCircuit: true };
    }
    if (["./renderer-http", "./gcs-media", "./google-auth"].includes(specifier)) {
      return {
        url: new URL(`${specifier}.ts`, context.parentURL).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "sceneflow-test:cloudflare-workers") {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const env = globalThis.__SCENEFLOW_TEST_CLOUDFLARE_ENV;",
      };
    }
    return nextLoad(url, context);
  },
});

const { findExistingLastFrame } = await import("../lib/renderer-client.ts");

const outputUri = "gs://sceneflow-staging/output/render-1.mp4";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("sends request ID and accepts the expected renderer output URI", async () => {
  let headers;
  const body = await callRendererHttp(
    "https://renderer.example",
    "secret-value",
    "/render",
    { clips: ["gs://input/clip.mp4"], outputGcsUri: outputUri },
    {
      requestId: "render-1",
      expectedOutputUri: outputUri,
      fetchImpl: async (_url, init) => {
        headers = new Headers(init.headers);
        return jsonResponse({ ok: true, outputUri, output: { durationSeconds: 4 } });
      },
    },
  );

  assert.equal(headers.get("x-request-id"), "render-1");
  assert.equal(headers.get("x-renderer-token"), "secret-value");
  assert.equal(body.outputUri, outputUri);
});

test("parses nested renderer errors and marks 429 as retryable", async () => {
  await assert.rejects(
    callRendererHttp("https://renderer.example", "secret", "/render", {}, {
      requestId: "render-2",
      expectedOutputUri: outputUri,
      fetchImpl: async () => jsonResponse(
        { ok: false, error: { code: "renderer_busy", message: "Capacity is full." } },
        429,
      ),
    }),
    (error) => {
      assert.ok(error instanceof RendererRequestError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "renderer_busy");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Capacity is full.");
      return true;
    },
  );
});

test("times out a renderer request", async () => {
  await assert.rejects(
    callRendererHttp("https://renderer.example", "secret", "/render", {}, {
      requestId: "render-3",
      expectedOutputUri: outputUri,
      timeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("Test request did not abort.")), 1_000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        }, { once: true });
      }),
    }),
    (error) => {
      assert.ok(error instanceof RendererRequestError);
      assert.equal(error.code, "renderer_timeout");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("rejects an unexpected output URI", async () => {
  await assert.rejects(
    callRendererHttp("https://renderer.example", "secret", "/render", {}, {
      requestId: "render-4",
      expectedOutputUri: outputUri,
      fetchImpl: async () => jsonResponse({
        ok: true,
        outputUri: "gs://other-bucket/unexpected.mp4",
      }),
    }),
    (error) => {
      assert.ok(error instanceof RendererRequestError);
      assert.equal(error.code, "renderer_output_uri_mismatch");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("accepts an authoritative renderer processing replay without an output URI", async () => {
  const body = await callRendererHttp(
    "https://renderer.example",
    "secret",
    "/extract-last-frame",
    {},
    {
      requestId: "job-1",
      expectedOutputUri: outputUri,
      fetchImpl: async () => jsonResponse({
        state: "processing",
        operationId: "extract-last-frame:v1:job-1",
        retryAfterMs: 5_000,
      }, 202),
    },
  );

  assert.equal(body.state, "processing");
  assert.equal(body.outputUri, undefined);
});

test("returns a durable renderer operation failure for polling reconciliation", async () => {
  const body = await callRendererHttp(
    "https://renderer.example",
    "secret",
    "/extract-last-frame",
    {},
    {
      requestId: "job-2",
      expectedOutputUri: outputUri,
      fetchImpl: async () => jsonResponse({
        state: "failed",
        operationId: "extract-last-frame:v1:job-2",
        error: { code: "frame_extraction_failed", message: "FFmpeg failed." },
      }, 422),
    },
  );

  assert.equal(body.state, "failed");
  assert.equal(body.error.code, "frame_extraction_failed");
});

test("production GCS artifact lookup pins both JPEG range reads to metadata generation", async () => {
  const metadata = await validContinuityMetadata();
  const calls = [];
  const result = await withGlobalFetch(async (url, init = {}) => {
    const parsed = new URL(String(url));
    const headers = new Headers(init.headers);
    calls.push({ parsed, headers });
    assert.equal(headers.get("authorization"), "Bearer test-gcs-token");
    if (!parsed.pathname.startsWith("/download/")) return jsonResponse(metadata);
    const range = headers.get("range");
    if (range === "bytes=0-2") {
      return byteResponse([0xff, 0xd8, 0xff], 206);
    }
    assert.equal(range, "bytes=4-5");
    return byteResponse([0xff, 0xd9], 206);
  }, findContinuityArtifact);

  assert.deepEqual(result, {
    status: "ready",
    endFrameUri:
      "gs://render-output/tenant/projects/prj_123/frames/scene_123-job_123-last.jpg",
    generation: "42",
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].parsed.pathname, /\/storage\/v1\/b\/render-output\/o\//);
  for (const call of calls.slice(1)) {
    assert.equal(call.parsed.searchParams.get("alt"), "media");
    assert.equal(call.parsed.searchParams.get("ifGenerationMatch"), "42");
  }
  assert.deepEqual(
    calls.slice(1).map((call) => call.headers.get("range")),
    ["bytes=0-2", "bytes=4-5"],
  );
});

test("production GCS artifact lookup rejects a metadata/media generation race", async () => {
  const metadata = await validContinuityMetadata();
  let mediaReads = 0;
  await assert.rejects(
    withGlobalFetch(async (url) => {
      const parsed = new URL(String(url));
      if (!parsed.pathname.startsWith("/download/")) return jsonResponse(metadata);
      mediaReads += 1;
      return new Response("generation changed", { status: 412 });
    }, findContinuityArtifact),
    /Unable to validate extracted frame output \(412\)/,
  );
  assert.equal(mediaReads, 1);
});

test("production GCS artifact lookup rejects malformed metadata before media reads", async () => {
  const valid = await validContinuityMetadata();
  const cases = [
    ["empty object", {}],
    ["empty size", { ...valid, size: "" }],
    ["zero size", { ...valid, size: "0" }],
    ["partial object", { ...valid, size: "4" }],
    ["malformed size", { ...valid, size: "6.5" }],
    ["wrong content type", { ...valid, contentType: "application/octet-stream" }],
    [
      "wrong binding",
      {
        ...valid,
        metadata: { ...valid.metadata, "veo3flow-scene-id": "scene_other" },
      },
    ],
  ];

  for (const [label, metadata] of cases) {
    let mediaReads = 0;
    const result = await withGlobalFetch(async (url) => {
      const parsed = new URL(String(url));
      if (!parsed.pathname.startsWith("/download/")) return jsonResponse(metadata);
      mediaReads += 1;
      throw new Error(`unexpected media read for ${label}`);
    }, findContinuityArtifact);
    assert.deepEqual(
      result,
      { status: "invalid", errorCode: "invalid_extraction_artifact" },
      label,
    );
    assert.equal(mediaReads, 0, label);
  }

  let mediaReads = 0;
  const malformedJson = await withGlobalFetch(async (url) => {
    const parsed = new URL(String(url));
    if (!parsed.pathname.startsWith("/download/")) {
      return new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    mediaReads += 1;
    throw new Error("unexpected media read for malformed JSON");
  }, findContinuityArtifact);
  assert.deepEqual(malformedJson, {
    status: "invalid",
    errorCode: "invalid_extraction_artifact",
  });
  assert.equal(mediaReads, 0);
});

test("production GCS artifact lookup validates both JPEG markers", async () => {
  const metadata = await validContinuityMetadata();
  for (const [label, first, last] of [
    ["wrong SOI", [0x00, 0xd8, 0xff], [0xff, 0xd9]],
    ["wrong EOI", [0xff, 0xd8, 0xff], [0xff, 0x00]],
  ]) {
    let mediaRead = 0;
    const result = await withGlobalFetch(async (url) => {
      const parsed = new URL(String(url));
      if (!parsed.pathname.startsWith("/download/")) return jsonResponse(metadata);
      mediaRead += 1;
      return byteResponse(mediaRead === 1 ? first : last, 206);
    }, findContinuityArtifact);
    assert.deepEqual(
      result,
      { status: "invalid", errorCode: "invalid_extraction_artifact" },
      label,
    );
    assert.equal(mediaRead, 2, label);
  }
});

test("production GCS metadata auth and transient failures fail closed", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(
      withGlobalFetch(
        async () => new Response("metadata failure", { status }),
        findContinuityArtifact,
      ),
      new RegExp(`Unable to check extracted frame output \\(${status}\\)`),
    );
  }
  await assert.rejects(
    withGlobalFetch(
      async () => {
        throw new Error("metadata network failed");
      },
      findContinuityArtifact,
    ),
    /metadata network failed/,
  );
});

test("production GCS pinned range auth and transient failures fail closed", async () => {
  const metadata = await validContinuityMetadata();
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(
      withGlobalFetch(async (url) => {
        const parsed = new URL(String(url));
        if (!parsed.pathname.startsWith("/download/")) return jsonResponse(metadata);
        return new Response("range failure", { status });
      }, findContinuityArtifact),
      new RegExp(`Unable to validate extracted frame output \\(${status}\\)`),
    );
  }
  await assert.rejects(
    withGlobalFetch(async (url) => {
      const parsed = new URL(String(url));
      if (!parsed.pathname.startsWith("/download/")) return jsonResponse(metadata);
      throw new Error("range network failed");
    }, findContinuityArtifact),
    /range network failed/,
  );
});

test("production GCS artifact lookup treats only metadata 404 as missing", async () => {
  let requests = 0;
  const result = await withGlobalFetch(async () => {
    requests += 1;
    return new Response("missing", { status: 404 });
  }, findContinuityArtifact);

  assert.deepEqual(result, { status: "missing" });
  assert.equal(requests, 1);
});

function findContinuityArtifact() {
  return findExistingLastFrame(
    "gs://veo-output/video.mp4",
    "prj_123",
    "scene_123",
    "job_123",
  );
}

async function validContinuityMetadata() {
  const inputUri = "gs://veo-output/video.mp4";
  return {
    bucket: "render-output",
    name: "tenant/projects/prj_123/frames/scene_123-job_123-last.jpg",
    size: "6",
    contentType: "image/jpeg",
    generation: "42",
    etag: "etag-42",
    metadata: {
      "veo3flow-project-id": "prj_123",
      "veo3flow-scene-id": "scene_123",
      "veo3flow-job-id": "job_123",
      "veo3flow-operation-id": "extract-last-frame:v1:job_123",
      "veo3flow-artifact-kind": "continuity-last-frame",
      "veo3flow-request-version": "1",
      "veo3flow-input-uri-sha256": await sha256Hex(inputUri),
    },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function byteResponse(bytes, status) {
  return new Response(Uint8Array.from(bytes), {
    status,
    headers: { "content-type": "image/jpeg" },
  });
}

async function withGlobalFetch(fetchImpl, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
