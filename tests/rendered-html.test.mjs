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

test("presents deterministic planning and the actual selected scene model truthfully", () => {
  const dashboard = readProjectFile("app/components/StudioDashboard.tsx");
  const sceneCard = readProjectFile("app/components/SceneCard.tsx");

  assert.doesNotMatch(dashboard, /AI hiểu ý bạn/);
  assert.doesNotMatch(dashboard, /Storyboard & keyframe/);
  assert.match(dashboard, /compilation\.compiler\.label/);
  assert.match(dashboard, /không dùng LLM/);
  assert.match(dashboard, /modelLabel\(job\.model\)/);
  assert.match(sceneCard, /scene\.sceneContract\.goal/);
  assert.match(sceneCard, /scene\.sceneContract\.startState\.compositionState/);
  assert.match(sceneCard, /scene\.sceneContract\.endState\.compositionState/);
  assert.match(sceneCard, /generationModeLabel/);
  assert.match(sceneCard, /riskFactors/);
  assert.match(sceneCard, /modelLabel\(activeJob\.model\)/);
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

test("wires manual QC controls, continuity locking and private scene playback", () => {
  const dashboard = readProjectFile("app/components/StudioDashboard.tsx");
  const sceneCard = readProjectFile("app/components/SceneCard.tsx");
  const actionPolicy = readProjectFile("app/components/scene-action-policy.ts");
  const mediaRoute = readProjectFile("app/api/scenes/[id]/media/route.ts");
  const privateVideoResponse = readProjectFile("lib/private-video-response.ts");

  assert.match(sceneCard, /Duyệt cảnh/);
  assert.match(sceneCard, /Từ chối/);
  assert.match(sceneCard, /scene-preview/);
  assert.match(dashboard, /\/api\/scenes\/\$\{scene\.id\}\/qc/);
  assert.match(dashboard, /refreshProjectScenes/);
  assert.match(dashboard, /getPipelineActionPolicy\(scenes, hasActiveGeneration\)/);
  assert.match(actionPolicy, /dependsOnSceneId/);
  assert.match(actionPolicy, /candidate\.status === "approved"/);
  assert.match(actionPolicy, /scene\.outputVideoUri && scene\.endFrameUri/);
  assert.match(actionPolicy, /kind: "wait_for_qc"/);
  assert.match(mediaRoute, /getOwnedScene/);
  assert.match(mediaRoute, /fetchPrivateGcsObject/);
  assert.match(mediaRoute, /parseSingleByteRange\(request\.headers\.get\("range"\)\)/);
  assert.match(mediaRoute, /parsedRange\.range\?\.headerValue/);
  assert.match(mediaRoute, /return await createPrivateVideoResponse/);
  assert.match(mediaRoute, /createMediaUpstreamFailedResponse/);
  assert.ok(
    mediaRoute.indexOf("const user = await getChatGPTUser()")
      < mediaRoute.indexOf("const parsedRange = parseSingleByteRange"),
    "scene media must authenticate before validating Range",
  );
  assert.ok(
    mediaRoute.indexOf("const scene = await getOwnedScene")
      < mediaRoute.indexOf("const parsedRange = parseSingleByteRange"),
    "scene media must check ownership before validating Range",
  );
  assert.ok(
    mediaRoute.indexOf("scene.outputVideoUri?.startsWith(\"mock://\")")
      < mediaRoute.indexOf("const parsedRange = parseSingleByteRange"),
    "mock media must redirect before validating Range",
  );
  assert.ok(
    mediaRoute.indexOf("if (!parsedRange.ok)")
      < mediaRoute.indexOf("const upstream = await fetchPrivateGcsObject"),
    "invalid Range must return locally before any GCS fetch",
  );
  assert.match(privateVideoResponse, /contentType !== "video\/mp4"/);
  assert.match(privateVideoResponse, /upstream\.status === 416/);
  assert.match(privateVideoResponse, /"cache-control": "private, no-store"/);
});
