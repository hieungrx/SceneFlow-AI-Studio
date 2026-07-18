import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const VALID_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9,
]);

const state = {
  user: { email: "owner@example.com" },
  parsedForm: null,
  parseCalls: [],
  project: { id: "prj_test" },
  projectCalls: [],
  putCalls: [],
  putError: null,
  createCalls: [],
  createError: null,
  createResult: null,
  deleteCalls: [],
  deleteError: null,
};
globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "next/server": "sceneflow-test:next-server",
      "../../chatgpt-auth": "sceneflow-test:chatgpt-auth",
      "../../../lib/bounded-multipart-request": "sceneflow-test:bounded-multipart-request",
      "../../../lib/media-store": "sceneflow-test:media-store",
      "../../../lib/repository": "sceneflow-test:repository",
    };
    if (specifier in stubs) {
      return { url: stubs[specifier], shortCircuit: true };
    }
    if (specifier === "../../../lib/asset-validation") {
      return {
        url: new URL("../../../lib/asset-validation.ts", context.parentURL).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "sceneflow-test:next-server") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const NextResponse = {
            json(body, init = {}) {
              return new Response(JSON.stringify(body), {
                status: init.status ?? 200,
                headers: { "content-type": "application/json; charset=utf-8" },
              });
            },
          };
        `,
      };
    }
    if (url === "sceneflow-test:chatgpt-auth") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function getChatGPTUser() {
            return globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST.user;
          }
        `,
      };
    }
    if (url === "sceneflow-test:bounded-multipart-request") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function parseBoundedMultipartFormData(request) {
            const state = globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST;
            state.parseCalls.push(request);
            return state.parsedForm;
          }
        `,
      };
    }
    if (url === "sceneflow-test:media-store") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function putProjectAsset(input) {
            const state = globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST;
            state.putCalls.push(input);
            if (state.putError) throw state.putError;
          }

          export async function deleteProjectAsset(key) {
            const state = globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST;
            state.deleteCalls.push(key);
            if (state.deleteError) throw state.deleteError;
          }
        `,
      };
    }
    if (url === "sceneflow-test:repository") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function getOwnedProject(ownerId, projectId) {
            const state = globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST;
            state.projectCalls.push({ ownerId, projectId });
            return state.project;
          }

          export async function createOwnedAsset(ownerId, input) {
            const state = globalThis.__SCENEFLOW_ASSETS_ROUTE_TEST;
            state.createCalls.push({ ownerId, input });
            if (state.createError) throw state.createError;
            return typeof state.createResult === "function"
              ? state.createResult(ownerId, input)
              : state.createResult;
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { POST } = await import("../app/api/assets/route.ts");

beforeEach(() => {
  state.user = { email: "owner@example.com" };
  state.parsedForm = validParsedForm();
  state.parseCalls = [];
  state.project = { id: "prj_test" };
  state.projectCalls = [];
  state.putCalls = [];
  state.putError = null;
  state.createCalls = [];
  state.createError = null;
  state.createResult = (ownerId, input) => ({
    ...input,
    ownerId,
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  state.deleteCalls = [];
  state.deleteError = null;
});

function request() {
  return POST(new Request("https://studio.example/api/assets", { method: "POST" }));
}

function validParsedForm({
  bytes = VALID_JPEG,
  type = "image/jpeg",
  name = "reference.png",
  projectId = "prj_test",
  kind = "product",
} = {}) {
  const formData = new FormData();
  formData.set("file", new File([bytes], name, { type }));
  formData.set("projectId", projectId);
  formData.set("kind", kind);
  return { ok: true, formData, bytesRead: bytes.byteLength };
}

async function responseBody(response) {
  return { status: response.status, body: await response.json() };
}

test("authentication runs before multipart parsing", async () => {
  state.user = null;

  const response = await request();

  assert.deepEqual(await responseBody(response), {
    status: 401,
    body: { error: "authentication_required" },
  });
  assert.equal(state.parseCalls.length, 0);
  assert.equal(state.projectCalls.length, 0);
  assert.equal(state.putCalls.length, 0);
});

test("oversized multipart request returns 413 before ownership lookup or R2", async () => {
  state.parsedForm = {
    ok: false,
    error: "asset_request_too_large",
    status: 413,
  };

  const response = await request();

  assert.deepEqual(await responseBody(response), {
    status: 413,
    body: { error: "asset_request_too_large" },
  });
  assert.equal(state.parseCalls.length, 1);
  assert.equal(state.projectCalls.length, 0);
  assert.equal(state.putCalls.length, 0);
  assert.equal(state.createCalls.length, 0);
});

test("invalid project returns 404 without writing R2", async () => {
  state.project = null;

  const response = await request();

  assert.deepEqual(await responseBody(response), {
    status: 404,
    body: { error: "project_not_found" },
  });
  assert.deepEqual(state.projectCalls, [{
    ownerId: "owner@example.com",
    projectId: "prj_test",
  }]);
  assert.equal(state.putCalls.length, 0);
  assert.equal(state.createCalls.length, 0);
});

test("MIME spoof is rejected before R2", async () => {
  state.parsedForm = validParsedForm({
    bytes: VALID_JPEG,
    type: "image/png",
    name: "spoof.png",
  });

  const response = await request();

  assert.deepEqual(await responseBody(response), {
    status: 415,
    body: { error: "unsupported_asset" },
  });
  assert.equal(state.putCalls.length, 0);
  assert.equal(state.createCalls.length, 0);
});

test("happy path uses detected MIME and extension instead of the filename", async () => {
  state.parsedForm = validParsedForm({
    bytes: VALID_JPEG,
    type: "image/jpeg",
    name: "misleading.png",
    kind: "character",
  });

  const response = await request();
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(state.putCalls.length, 1);
  const uploaded = state.putCalls[0];
  assert.match(uploaded.key, /^projects\/prj_test\/references\/asset_[A-Za-z0-9-]+\.jpg$/);
  assert.equal(uploaded.contentType, "image/jpeg");
  assert.equal(uploaded.originalName, "misleading.png");
  assert.equal(uploaded.kind, "character");
  assert.ok(uploaded.body instanceof Blob);
  assert.deepEqual(new Uint8Array(await uploaded.body.arrayBuffer()), VALID_JPEG);

  assert.equal(state.createCalls.length, 1);
  const created = state.createCalls[0];
  assert.equal(created.input.r2Key, uploaded.key);
  assert.equal(created.input.contentType, "image/jpeg");
  assert.equal(created.input.filename, "misleading.png");
  assert.equal(created.input.sizeBytes, VALID_JPEG.byteLength);
  assert.equal(body.asset.r2Key, uploaded.key);
  assert.equal(state.deleteCalls.length, 0);
});

test("R2 failure returns a safe error and never creates DB metadata", async () => {
  state.putError = new Error("secret R2 credential failure");

  const response = await request();
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.equal(text, JSON.stringify({ error: "media_storage_unavailable" }));
  assert.doesNotMatch(text, /secret R2 credential failure/);
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.deleteCalls.length, 0);
});

test("DB failure deletes the exact uploaded object key", async () => {
  state.createError = new Error("secret database failure");

  const response = await request();
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.equal(text, JSON.stringify({ error: "asset_metadata_unavailable" }));
  assert.doesNotMatch(text, /secret database failure/);
  assert.equal(state.putCalls.length, 1);
  assert.deepEqual(state.deleteCalls, [state.putCalls[0].key]);
});

test("compensating delete failure still returns a safe metadata error", async () => {
  state.createError = new Error("secret database failure");
  state.deleteError = new Error("secret delete failure");
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);

  let response;
  try {
    response = await request();
  } finally {
    console.error = originalConsoleError;
  }
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.equal(text, JSON.stringify({ error: "asset_metadata_unavailable" }));
  assert.doesNotMatch(text, /secret database failure|secret delete failure/);
  assert.deepEqual(state.deleteCalls, [state.putCalls[0].key]);
  assert.equal(logged.length, 1);
  assert.doesNotMatch(JSON.stringify(logged), /secret database failure|secret delete failure/);
});

test("a null metadata result cleans up the upload and returns 404", async () => {
  state.createResult = null;

  const response = await request();

  assert.deepEqual(await responseBody(response), {
    status: 404,
    body: { error: "project_not_found" },
  });
  assert.equal(state.putCalls.length, 1);
  assert.deepEqual(state.deleteCalls, [state.putCalls[0].key]);
});
