import assert from "node:assert/strict";
import test from "node:test";

import { parseBoundedMultipartFormData } from "../lib/bounded-multipart-request.ts";

test("parses valid multipart data within the hard request cap", async () => {
  const form = new FormData();
  form.set("projectId", "prj_test");
  form.set("kind", "product");
  form.set("file", new File([Uint8Array.from([1, 2, 3])], "reference.bin"));
  const request = new Request("https://studio.example/api/assets", {
    method: "POST",
    body: form,
  });

  const result = await parseBoundedMultipartFormData(request, 4_096);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.formData.get("projectId"), "prj_test");
  assert.equal(result.formData.get("kind"), "product");
  assert.equal(result.formData.get("file")?.size, 3);
  assert.ok(result.bytesRead > 3);
  assert.ok(result.bytesRead <= 4_096);
});

test("rejects an oversized declared Content-Length before reading the body", async () => {
  const request = {
    headers: new Headers({
      "content-length": "101",
      "content-type": "multipart/form-data; boundary=test",
    }),
    get body() {
      throw new Error("the body must not be touched");
    },
  };

  assert.deepEqual(await parseBoundedMultipartFormData(request, 100), {
    ok: false,
    error: "asset_request_too_large",
    status: 413,
  });
});

test("enforces the hard cap when Content-Length is missing", async () => {
  const body = multipartBody("limit", "x".repeat(80));
  const request = new Request("https://studio.example/api/assets", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=limit" },
    body,
  });

  assert.deepEqual(await parseBoundedMultipartFormData(request, body.byteLength - 1), {
    ok: false,
    error: "asset_request_too_large",
    status: 413,
  });
});

test("accepts a body exactly at the configured byte cap", async () => {
  const body = multipartBody("exact", "value");
  const request = new Request("https://studio.example/api/assets", {
    method: "POST",
    headers: {
      "content-length": String(body.byteLength),
      "content-type": "multipart/form-data; boundary=exact",
    },
    body,
  });

  const result = await parseBoundedMultipartFormData(request, body.byteLength);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bytesRead, body.byteLength);
  assert.equal(result.formData.get("field"), "value");
});

test("returns stable errors for invalid limits, lengths and multipart bodies", async (t) => {
  await t.test("invalid request limit", async () => {
    const request = new Request("https://studio.example/api/assets", { method: "POST" });
    assert.deepEqual(await parseBoundedMultipartFormData(request, 0), {
      ok: false,
      error: "invalid_request_limit",
      status: 500,
    });
  });

  await t.test("invalid Content-Length", async () => {
    const request = {
      headers: new Headers({
        "content-length": "not-a-number",
        "content-type": "multipart/form-data; boundary=test",
      }),
      body: null,
    };
    assert.deepEqual(await parseBoundedMultipartFormData(request, 100), {
      ok: false,
      error: "invalid_content_length",
      status: 400,
    });
  });

  await t.test("wrong Content-Type", async () => {
    const request = new Request("https://studio.example/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.deepEqual(await parseBoundedMultipartFormData(request, 100), {
      ok: false,
      error: "invalid_multipart_request",
      status: 400,
    });
  });

  await t.test("malformed multipart body", async () => {
    const request = new Request("https://studio.example/api/assets", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=broken" },
      body: "not multipart",
    });
    assert.deepEqual(await parseBoundedMultipartFormData(request, 100), {
      ok: false,
      error: "invalid_multipart_request",
      status: 400,
    });
  });
});

test("does not expose a body stream failure", async () => {
  const request = new Request("https://studio.example/api/assets", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=test" },
    body: new ReadableStream({
      pull() {
        throw new Error("internal stream detail");
      },
    }),
    duplex: "half",
  });

  assert.deepEqual(await parseBoundedMultipartFormData(request, 100), {
    ok: false,
    error: "request_body_unreadable",
    status: 400,
  });
});

function multipartBody(boundary, value) {
  return new TextEncoder().encode(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="field"\r\n\r\n' +
      `${value}\r\n` +
      `--${boundary}--\r\n`,
  );
}
