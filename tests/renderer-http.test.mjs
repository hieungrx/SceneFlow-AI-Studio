import assert from "node:assert/strict";
import test from "node:test";

import {
  callRendererHttp,
  RendererRequestError,
} from "../lib/renderer-http.ts";

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
