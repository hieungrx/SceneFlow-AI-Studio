import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function readProjectFile(path) {
  return readFileSync(join(root, path), "utf8");
}

test("contains the SceneFlow studio experience", () => {
  const dashboard = readProjectFile("app/components/StudioDashboard.tsx");
  const page = readProjectFile("app/page.tsx");

  assert.match(dashboard, /SceneFlow/i);
  assert.match(dashboard, /storyboard/i);
  assert.match(dashboard, /Veo/i);
  assert.match(dashboard, /prompt/i);
  assert.match(page, /StudioDashboard/);
});

test("removes the disposable starter preview", () => {
  const dashboard = readProjectFile("app/components/StudioDashboard.tsx");
  const page = readProjectFile("app/page.tsx");

  const combined = `${dashboard}\n${page}`;

  assert.doesNotMatch(combined, /Get started by editing/i);
  assert.doesNotMatch(combined, /Save and see your changes instantly/i);
  assert.doesNotMatch(combined, /Deploy now/i);
  assert.doesNotMatch(combined, /Read our docs/i);
});

test("wires the mock pipeline through a playable final render", () => {
  const renderRoute = readProjectFile("app/api/projects/[id]/render/route.ts");
  const mediaRoute = readProjectFile("app/api/renders/[id]/media/route.ts");
  const repository = readProjectFile("lib/repository.ts");
  const dashboard = readProjectFile("app/components/StudioDashboard.tsx");
  const preview = statSync(join(root, "public/mock/sceneflow-preview.mp4"));

  assert.match(renderRoute, /mock-ffmpeg/);
  assert.match(renderRoute, /mediaUrl/);
  assert.match(mediaRoute, /\/mock\//);
  assert.match(repository, /memory\.saveRender/);
  assert.match(repository, /memory\.getRender/);
  assert.match(dashboard, /render-preview/);
  assert.ok(preview.size > 1_000, "mock preview must contain playable MP4 data");
});

test("guards final rendering by approval and reuses an active render", () => {
  const renderRoute = readProjectFile("app/api/projects/[id]/render/route.ts");
  const repository = readProjectFile("lib/repository.ts");

  assert.match(renderRoute, /scene\.status !== "approved"/);
  assert.match(renderRoute, /reserveOwnedFinalRender/);
  assert.match(renderRoute, /findOwnedActiveJobForProject/);
  assert.match(renderRoute, /status: "running"/);
  assert.match(renderRoute, /status: "failed"/);
  assert.match(repository, /inArray\(finalRendersTable\.status, \["queued", "running"\]\)/);
});
