import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const state = {
  user: { email: "owner@example.com" },
  render: null,
  ownershipCalls: [],
  fetchCalls: [],
  upstreamFactory: () => new Response("video", {
    status: 200,
    headers: { "content-type": "video/mp4", "content-length": "5" },
  }),
  fetchError: null,
};
globalThis.__SCENEFLOW_RENDER_MEDIA_ROUTE_TEST = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      "next/server": "sceneflow-test:next-server",
      "../../../../chatgpt-auth": "sceneflow-test:chatgpt-auth",
      "../../../../../lib/gcs-media": "sceneflow-test:gcs-media",
      "../../../../../lib/repository": "sceneflow-test:repository",
    };
    if (specifier in stubs) {
      return { url: stubs[specifier], shortCircuit: true };
    }
    if (specifier === "../../../../../lib/private-video-response") {
      return {
        url: new URL("../../../../../lib/private-video-response.ts", context.parentURL).href,
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
            redirect(url, status = 307) {
              return new Response(null, { status, headers: { location: String(url) } });
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
            return globalThis.__SCENEFLOW_RENDER_MEDIA_ROUTE_TEST.user;
          }
        `,
      };
    }
    if (url === "sceneflow-test:repository") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function getOwnedRender(ownerId, renderId) {
            const state = globalThis.__SCENEFLOW_RENDER_MEDIA_ROUTE_TEST;
            state.ownershipCalls.push({ ownerId, renderId });
            return state.render;
          }
        `,
      };
    }
    if (url === "sceneflow-test:gcs-media") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export async function fetchPrivateGcsObject(uri, range) {
            const state = globalThis.__SCENEFLOW_RENDER_MEDIA_ROUTE_TEST;
            state.fetchCalls.push({ uri, range });
            if (state.fetchError) throw state.fetchError;
            return state.upstreamFactory();
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { GET } = await import("../app/api/renders/[id]/media/route.ts");

beforeEach(() => {
  state.user = { email: "owner@example.com" };
  state.render = {
    id: "render_test",
    outputVideoUri: "gs://private-bucket/render.mp4",
  };
  state.ownershipCalls = [];
  state.fetchCalls = [];
  state.upstreamFactory = () => new Response("video", {
    status: 200,
    headers: { "content-type": "video/mp4", "content-length": "5" },
  });
  state.fetchError = null;
});

function request(range) {
  const headers = range === undefined ? {} : { range };
  return GET(
    new Request("https://studio.example/api/renders/render_test/media", { headers }),
    { params: Promise.resolve({ id: "render_test" }) },
  );
}

test("auth and ownership run before Range validation", async (t) => {
  await t.test("unauthenticated", async () => {
    state.user = null;
    const response = await request("bytes=0-1,2-3");

    assert.equal(response.status, 401);
    assert.equal(state.ownershipCalls.length, 0);
    assert.equal(state.fetchCalls.length, 0);
  });

  await t.test("not owned", async () => {
    state.render = null;
    const response = await request("bytes=0-1,2-3");

    assert.equal(response.status, 404);
    assert.equal(state.ownershipCalls.length, 1);
    assert.equal(state.fetchCalls.length, 0);
  });
});

test("mock and not-ready handling run before Range validation", async (t) => {
  await t.test("mock redirect", async () => {
    state.render.outputVideoUri = "/mock/sceneflow-preview.mp4";
    const response = await request("bytes=0-1,2-3");

    assert.equal(response.status, 307);
    assert.match(response.headers.get("location") ?? "", /\/mock\/sceneflow-preview\.mp4$/);
    assert.equal(state.fetchCalls.length, 0);
  });

  await t.test("not ready", async () => {
    state.render.outputVideoUri = null;
    const response = await request("bytes=0-1,2-3");

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "render_media_not_ready" });
    assert.equal(state.fetchCalls.length, 0);
  });
});

test("invalid GCS Range returns local 416 without an upstream fetch", async () => {
  const response = await request("bytes=0-1,2-3");

  assert.equal(response.status, 416);
  assert.deepEqual(await response.json(), { error: "invalid_media_range" });
  assert.equal(state.fetchCalls.length, 0);
});

test("normalizes one valid Range and accepts a strict MP4 partial response", async () => {
  state.upstreamFactory = () => new Response("01", {
    status: 206,
    headers: {
      "content-type": "video/mp4",
      "content-length": "2",
      "content-range": "bytes 0-1/10",
    },
  });

  const response = await request("BYTES=000-001");

  assert.equal(response.status, 206);
  assert.deepEqual(state.fetchCalls, [{
    uri: "gs://private-bucket/render.mp4",
    range: "bytes=0-1",
  }]);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-range"), "bytes 0-1/10");
  assert.equal(await response.text(), "01");
});

test("rejects mismatched success status and non-MP4 upstream content", async (t) => {
  await t.test("Range request with upstream 200", async () => {
    const response = await request("bytes=0-1");

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "media_upstream_failed" });
  });

  await t.test("non-MP4 full response", async () => {
    state.upstreamFactory = () => new Response("sensitive upstream body", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const response = await request();
    const text = await response.text();

    assert.equal(response.status, 502);
    assert.equal(text, JSON.stringify({ error: "media_upstream_failed" }));
    assert.doesNotMatch(text, /sensitive upstream body/);
  });
});

test("preserves a valid upstream 416 without exposing its body", async () => {
  state.upstreamFactory = () => new Response("sensitive GCS error", {
    status: 416,
    headers: { "content-range": "bytes */10", "content-type": "application/json" },
  });

  const response = await request("bytes=10-20");

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */10");
  assert.deepEqual(await response.json(), { error: "media_range_not_satisfiable" });
});

test("maps a thrown GCS request to one safe upstream error", async () => {
  state.fetchError = new Error("sensitive token failure");
  const response = await request();
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.equal(text, JSON.stringify({ error: "media_upstream_failed" }));
  assert.doesNotMatch(text, /sensitive token failure/);
});
