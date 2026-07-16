import assert from "node:assert/strict";
import test from "node:test";

import {
  createInvalidMediaRangeResponse,
  createPrivateVideoResponse,
  parseSingleByteRange,
} from "../lib/private-video-response.ts";

function parsedRange(value) {
  const result = parseSingleByteRange(value);
  assert.equal(result.ok, true);
  assert.ok(result.range);
  return result.range;
}

function videoResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "video/mp4", ...headers },
  });
}

async function assertUpstreamFailure(response) {
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "media_upstream_failed" });
}

test("parses and normalizes one supported byte range", () => {
  assert.deepEqual(parseSingleByteRange(null), { ok: true, range: null });
  assert.deepEqual(parseSingleByteRange("bytes=0-99"), {
    ok: true,
    range: { kind: "closed", start: 0, end: 99, headerValue: "bytes=0-99" },
  });
  assert.deepEqual(parseSingleByteRange("BYTES=001-009"), {
    ok: true,
    range: { kind: "closed", start: 1, end: 9, headerValue: "bytes=1-9" },
  });
  assert.deepEqual(parseSingleByteRange("bytes=25-"), {
    ok: true,
    range: { kind: "open", start: 25, headerValue: "bytes=25-" },
  });
  assert.deepEqual(parseSingleByteRange("bytes=-32"), {
    ok: true,
    range: { kind: "suffix", suffixLength: 32, headerValue: "bytes=-32" },
  });
});

test("rejects malformed, multiple, reversed and unsafe byte ranges", () => {
  const invalidRanges = [
    "",
    "bytes=-",
    "bytes=0-1,2-3",
    "bytes=5-4",
    "bytes=-0",
    "bytes= 0-1",
    "bytes=0 -1",
    "items=0-1",
    "bytes=+1-2",
    "bytes=1.5-2",
    "bytes=9007199254740992-",
    `bytes=${"1".repeat(129)}-`,
  ];

  for (const value of invalidRanges) {
    assert.deepEqual(parseSingleByteRange(value), { ok: false }, value);
  }
});

test("returns a safe local 416 for an invalid Range header", async () => {
  const response = createInvalidMediaRangeResponse();

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { error: "invalid_media_range" });
});

test("streams a full MP4 response with only safe headers", async () => {
  const upstream = videoResponse("video", {
    headers: {
      "content-type": "Video/MP4; profile=main",
      "content-length": "5",
      etag: "\"gcs-etag\"",
      "x-goog-meta-secret": "do-not-forward",
    },
  });
  const response = await createPrivateVideoResponse(upstream, {
    range: null,
    filename: "clip\r\nX-Unsafe: value.mp4",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-length"), "5");
  assert.equal(response.headers.get("etag"), "\"gcs-etag\"");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-goog-meta-secret"), null);
  assert.match(response.headers.get("content-disposition"), /^inline; filename="[A-Za-z0-9._-]+"$/);
  assert.doesNotMatch(response.headers.get("content-disposition"), /[\r\n]/);
  assert.equal(await response.text(), "video");
});

test("accepts consistent closed, open and suffix partial responses", async (t) => {
  const cases = [
    {
      name: "closed",
      request: "bytes=2-5",
      contentRange: "bytes 2-5/10",
      body: "2345",
    },
    {
      name: "closed range truncated at EOF",
      request: "bytes=7-99",
      contentRange: "bytes 7-9/10",
      body: "789",
    },
    {
      name: "open",
      request: "bytes=7-",
      contentRange: "bytes 7-9/10",
      body: "789",
    },
    {
      name: "suffix",
      request: "bytes=-3",
      contentRange: "bytes 7-9/10",
      body: "789",
    },
    {
      name: "suffix larger than representation",
      request: "bytes=-20",
      contentRange: "bytes 0-9/10",
      body: "0123456789",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const upstream = videoResponse(item.body, {
        status: 206,
        headers: {
          "content-range": item.contentRange,
          "content-length": String(item.body.length),
        },
      });
      const response = await createPrivateVideoResponse(upstream, {
        range: parsedRange(item.request),
        filename: "scene.mp4",
      });

      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), item.contentRange);
      assert.equal(response.headers.get("content-length"), String(item.body.length));
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(await response.text(), item.body);
    });
  }
});

test("rejects success statuses that do not match the client request", async (t) => {
  await t.test("Range request with upstream 200", async () => {
    const response = await createPrivateVideoResponse(videoResponse("full"), {
      range: parsedRange("bytes=0-1"),
      filename: "scene.mp4",
    });
    await assertUpstreamFailure(response);
  });

  await t.test("upstream 206 without a Range request", async () => {
    const response = await createPrivateVideoResponse(videoResponse("pa", {
      status: 206,
      headers: { "content-range": "bytes 0-1/4", "content-length": "2" },
    }), { range: null, filename: "scene.mp4" });
    await assertUpstreamFailure(response);
  });

  await t.test("upstream 200 with Content-Range", async () => {
    const response = await createPrivateVideoResponse(videoResponse("full", {
      headers: { "content-range": "bytes 0-3/4" },
    }), { range: null, filename: "scene.mp4" });
    await assertUpstreamFailure(response);
  });
});

test("rejects malformed or inconsistent partial response headers", async (t) => {
  const cases = [
    { name: "missing Content-Range", headers: { "content-length": "2" } },
    { name: "malformed Content-Range", headers: { "content-range": "0-1/10", "content-length": "2" } },
    { name: "wrong interval", headers: { "content-range": "bytes 1-2/10", "content-length": "2" } },
    { name: "end outside total", headers: { "content-range": "bytes 0-10/10", "content-length": "11" } },
    { name: "length mismatch", headers: { "content-range": "bytes 0-1/10", "content-length": "3" } },
    { name: "invalid length", headers: { "content-range": "bytes 0-1/10", "content-length": "two" } },
    { name: "unsafe total", headers: { "content-range": "bytes 0-1/9007199254740992", "content-length": "2" } },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const response = await createPrivateVideoResponse(videoResponse("01", {
        status: 206,
        headers: item.headers,
      }), { range: parsedRange("bytes=0-1"), filename: "scene.mp4" });
      await assertUpstreamFailure(response);
    });
  }
});

test("fails closed for a missing or non-MP4 upstream MIME type", async (t) => {
  for (const contentType of [null, "text/html", "application/octet-stream"]) {
    await t.test(contentType ?? "missing MIME", async () => {
      const headers = contentType ? { "content-type": contentType } : {};
      const upstream = new Response("provider secret", { status: 200, headers });
      const response = await createPrivateVideoResponse(upstream, {
        range: null,
        filename: "scene.mp4",
      });
      await assertUpstreamFailure(response);
    });
  }
});

test("preserves a valid upstream 416 without exposing its body", async () => {
  const upstream = new Response("sensitive GCS error", {
    status: 416,
    headers: { "content-range": "bytes */10", "content-type": "application/json" },
  });
  const response = await createPrivateVideoResponse(upstream, {
    range: parsedRange("bytes=10-20"),
    filename: "scene.mp4",
  });

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */10");
  assert.deepEqual(await response.json(), { error: "media_range_not_satisfiable" });
});

test("rejects an inconsistent or malformed upstream 416", async (t) => {
  const cases = [
    { name: "no client Range", range: null, contentRange: "bytes */10" },
    { name: "missing Content-Range", range: parsedRange("bytes=10-20"), contentRange: null },
    { name: "malformed Content-Range", range: parsedRange("bytes=10-20"), contentRange: "bytes 10-20/*" },
    { name: "satisfiable start", range: parsedRange("bytes=9-20"), contentRange: "bytes */10" },
    { name: "satisfiable suffix", range: parsedRange("bytes=-1"), contentRange: "bytes */10" },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const headers = item.contentRange ? { "content-range": item.contentRange } : {};
      const upstream = new Response("sensitive GCS error", { status: 416, headers });
      const response = await createPrivateVideoResponse(upstream, {
        range: item.range,
        filename: "scene.mp4",
      });
      await assertUpstreamFailure(response);
    });
  }
});

test("maps upstream authorization, lookup and server errors to one safe 502", async (t) => {
  for (const status of [401, 403, 404, 500, 503]) {
    await t.test(String(status), async () => {
      const upstream = new Response(`sensitive upstream ${status}`, { status });
      const response = await createPrivateVideoResponse(upstream, {
        range: null,
        filename: "scene.mp4",
      });
      const text = await response.text();

      assert.equal(response.status, 502);
      assert.equal(text, JSON.stringify({ error: "media_upstream_failed" }));
      assert.doesNotMatch(text, /sensitive upstream/);
    });
  }
});

test("cancels a rejected upstream body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("sensitive upstream body"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const upstream = new Response(body, {
    status: 200,
    headers: { "content-type": "text/html" },
  });

  const response = await createPrivateVideoResponse(upstream, {
    range: null,
    filename: "scene.mp4",
  });

  assert.equal(cancelled, true);
  await assertUpstreamFailure(response);
});
