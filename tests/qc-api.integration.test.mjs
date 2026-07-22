import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";

const root = process.cwd();
const owner = "qc-owner@example.com";
const concreteStoryBible = {
  characterLock: "Vietnamese barista, black bob hair, beige linen shirt, dark brown apron.",
  productLock: "White 180 ml cup with a cobalt rim, no text, no logo.",
  environmentLock: "Small coffee shop with walnut counter and copper espresso machine.",
  lightingLock: "Warm 7 AM light always enters from camera left.",
  visualStyle: "Photorealistic warm cinematic commercial with shallow depth of field.",
  audioDirection: "Natural coffee shop room tone without dialogue.",
  mustAvoid: ["identity drift", "cup deformation", "extra hands"],
};
let baseUrl;
let runtime;
let stateDirectory;
let runtimeOutput = "";

before(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  stateDirectory = mkdtempSync(join(tmpdir(), "sceneflow-qc-api-"));
  runtime = spawn(
    process.execPath,
    [
      join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--config",
      join(root, "dist", "server", "wrangler.json"),
      "--persist-to",
      stateDirectory,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(stateDirectory, "wrangler.log"),
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  runtime.stdout.on("data", (chunk) => {
    runtimeOutput = `${runtimeOutput}${chunk}`.slice(-20_000);
  });
  runtime.stderr.on("data", (chunk) => {
    runtimeOutput = `${runtimeOutput}${chunk}`.slice(-20_000);
  });
  await waitForRuntime();
});

after(async () => {
  if (runtime && runtime.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(runtime.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      runtime.kill("SIGTERM");
      const exited = await waitForExit(10_000);
      if (!exited && runtime.exitCode === null) runtime.kill("SIGKILL");
    }
    await waitForExit(5_000);
  }
  if (stateDirectory) await removeStateDirectory();
});

test("manual QC API runtime behavior", async (t) => {
  await t.test("auth runs before payload and lookup", async () => {
    const response = await api("/api/scenes/scene_unknown/qc", {
      method: "POST",
      body: { decision: "approve" },
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "authentication_required");
  });

  await t.test("project API creates and updates concrete Story Bible before planning", async () => {
    const ownerId = "story-bible-runtime@example.com";
    const missing = await api("/api/projects", {
      method: "POST",
      ownerId,
      body: {
        name: "Missing Story Bible",
        brief: "A concrete runtime request that intentionally omits product truth.",
      },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "invalid_story_bible");

    const generic = await api("/api/projects", {
      method: "POST",
      ownerId,
      body: {
        name: "Generic Story Bible",
        brief: "A runtime request that attempts to use unbound references.",
        storyBible: {
          ...concreteStoryBible,
          characterLock: "Giữ nguyên khuôn mặt và trang phục từ ảnh tham chiếu.",
        },
      },
    });
    assert.equal(generic.status, 400);
    assert.equal(generic.body.error, "invalid_story_bible");
    assert.ok(generic.body.issues.some((issue) => issue.code === "unbound_reference"));

    const created = await createProject(ownerId, concreteStoryBible);
    assert.deepEqual(created.storyBible, concreteStoryBible);

    const unauthenticatedUpdate = await api(`/api/projects/${created.id}`, {
      method: "PATCH",
      body: { storyBible: concreteStoryBible },
    });
    assert.equal(unauthenticatedUpdate.status, 401);
    const nonOwnerUpdate = await api(`/api/projects/${created.id}`, {
      method: "PATCH",
      ownerId: "story-bible-other@example.com",
      body: { storyBible: concreteStoryBible },
    });
    assert.equal(nonOwnerUpdate.status, 404);

    const updatedStoryBible = {
      ...concreteStoryBible,
      visualStyle: "Photorealistic premium coffee film with warm amber highlights and fine grain.",
      audioDirection: "Quiet coffee shop room tone, one ceramic cup sound, no music and no dialogue.",
    };
    const updated = await api(`/api/projects/${created.id}`, {
      method: "PATCH",
      ownerId,
      body: { storyBible: updatedStoryBible },
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.project.storyBible, updatedStoryBible);

    const storyboard = await api(`/api/projects/${created.id}/storyboard`, {
      method: "POST",
      ownerId,
    });
    assert.equal(storyboard.status, 201);
    assert.deepEqual(storyboard.body.storyboard.compiled.storyBible, updatedStoryBible);
    assert.ok(storyboard.body.storyboard.compiled.sceneContracts.every((contract) =>
      contract.visualStyle === updatedStoryBible.visualStyle &&
      contract.audioDirection === updatedStoryBible.audioDirection
    ));
    const firstScene = storyboard.body.scenes[0];
    for (const field of [
      "characterLock",
      "productLock",
      "environmentLock",
      "lightingLock",
      "visualStyle",
      "audioDirection",
    ]) {
      assert.match(firstScene.prompt, new RegExp(escapeRegExp(updatedStoryBible[field])));
    }
    assert.doesNotMatch(
      firstScene.prompt,
      /chưa khóa|ảnh tham chiếu|ảnh tải lên|reference (?:image|asset|input)|bound reference/i,
    );
  });

  await t.test("storyboard replan increments versions and preserves authoritative history", async () => {
    const fixture = await createStoryboard("storyboard-version@example.com");
    assert.equal(fixture.storyboard.version, 1);
    assert.equal(fixture.storyboard.compiled.sceneContracts.length, 4);
    const originalStoryboard = structuredClone(fixture.storyboard);
    const beforeReplan = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      ownerId: fixture.ownerId,
    });
    assert.equal(beforeReplan.status, 200);
    const originalPromptVersions = structuredClone(beforeReplan.body.promptVersions);

    const replanned = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });
    assert.equal(replanned.status, 201);
    assert.equal(replanned.body.storyboard.version, 2);
    assert.notEqual(replanned.body.storyboard.id, fixture.storyboard.id);

    const history = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      ownerId: fixture.ownerId,
    });
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.storyboards.map((storyboard) => storyboard.version), [2, 1]);
    assert.equal(history.body.storyboards[0].status, "active");
    assert.equal(history.body.storyboards[1].status, "superseded");
    assert.deepEqual(history.body.storyboards[1].compiled, originalStoryboard.compiled);
    assert.equal(history.body.promptVersions.length, 8);
    assert.ok(
      originalStoryboard.compiled.sceneContracts.every((contract) =>
        history.body.promptVersions.some((promptVersion) =>
          promptVersion.sceneId === contract.sceneId &&
          promptVersion.compilerVersion === "scene-contract-prompt-v2"
        )
      ),
    );
    for (const originalPrompt of originalPromptVersions) {
      const preserved = history.body.promptVersions.find((item) => item.id === originalPrompt.id);
      assert.ok(preserved, `prompt history ${originalPrompt.id} must be preserved`);
      assert.equal(preserved.optimizedPrompt, originalPrompt.optimizedPrompt);
      assert.equal(preserved.negativePrompt, originalPrompt.negativePrompt);
      assert.equal(preserved.generationMode, originalPrompt.generationMode);
      assert.equal(preserved.compilerVersion, originalPrompt.compilerVersion);
      assert.equal(preserved.targetProvider, originalPrompt.targetProvider);
      assert.deepEqual(preserved.compilerConfig, originalPrompt.compilerConfig);
      assert.deepEqual(preserved.compiledPayload, originalPrompt.compiledPayload);
      assert.equal(preserved.compiledPayload.prompt, originalPrompt.optimizedPrompt);
      assert.equal(preserved.compiledPayload.negativePrompt, originalPrompt.negativePrompt);
    }

    const active = await api(`/api/projects/${fixture.project.id}`, {
      ownerId: fixture.ownerId,
    });
    assert.equal(active.status, 200);
    assert.equal(active.body.scenes.length, 4);
    for (const scene of active.body.scenes) {
      assert.equal(scene.storyboardId, replanned.body.storyboard.id);
      assert.equal(scene.storyboardVersion, 2);
      assert.equal(scene.sceneContract.sceneId, scene.id);
      assert.equal(scene.promptVersion, 1);
      assert.equal(scene.promptCompilerVersion, "scene-contract-prompt-v2");
    }
  });

  await t.test("storyboard history retrieval is owner-scoped", async () => {
    const fixture = await createStoryboard("storyboard-owner@example.com");
    const unauthenticated = await api(`/api/projects/${fixture.project.id}/storyboard`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error, "authentication_required");

    const nonOwner = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      ownerId: "storyboard-other@example.com",
    });
    assert.equal(nonOwner.status, 404);
    assert.equal(nonOwner.body.error, "project_not_found");
  });

  await t.test("concurrent replans serialize versions and leave one coherent active projection", async () => {
    const fixture = await createStoryboard("storyboard-concurrent@example.com");
    const responses = await Promise.all([
      api(`/api/projects/${fixture.project.id}/storyboard`, {
        method: "POST",
        ownerId: fixture.ownerId,
      }),
      api(`/api/projects/${fixture.project.id}/storyboard`, {
        method: "POST",
        ownerId: fixture.ownerId,
      }),
    ]);
    for (const response of responses) assert.equal(response.status, 201);
    assert.deepEqual(responses.map((response) => response.body.storyboard.version).sort(), [2, 3]);

    const history = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      ownerId: fixture.ownerId,
    });
    assert.deepEqual(history.body.storyboards.map((storyboard) => storyboard.version), [3, 2, 1]);
    assert.equal(
      history.body.storyboards.filter((storyboard) => storyboard.status === "active").length,
      1,
    );
    const activeStoryboard = history.body.storyboards[0];
    const project = await api(`/api/projects/${fixture.project.id}`, {
      ownerId: fixture.ownerId,
    });
    assert.ok(project.body.scenes.every((scene) => scene.storyboardId === activeStoryboard.id));
    assert.ok(project.body.scenes.every((scene) => scene.storyboardVersion === 3));
  });

  await t.test("approved storyboard requires explicit confirmation before replan", async () => {
    const fixture = await createStoryboard("storyboard-approved@example.com");
    await executeLocalSql(
      `UPDATE scenes SET status = 'approved' WHERE id = '${sqlText(fixture.scenes[0].id)}';`,
    );

    const blocked = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "approved_storyboard_requires_confirmation");
    const beforeConfirmation = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      ownerId: fixture.ownerId,
    });
    assert.deepEqual(beforeConfirmation.body.storyboards.map((storyboard) => storyboard.version), [1]);

    const confirmed = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      method: "POST",
      ownerId: fixture.ownerId,
      body: { confirmApprovedReplacement: true },
    });
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.storyboard.version, 2);
  });

  await t.test("replan refuses execution history so existing scene and job references stay valid", async () => {
    const fixture = await createQualityCheckScene("storyboard-history-guard@example.com");
    const blocked = await api(`/api/projects/${fixture.project.id}/storyboard`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "storyboard_replan_has_execution_history");

    const project = await api(`/api/projects/${fixture.project.id}`, {
      ownerId: fixture.ownerId,
    });
    assert.equal(project.status, 200);
    assert.ok(project.body.scenes.some((scene) => scene.id === fixture.scene.id));
    const job = await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    assert.equal(job.status, 200);
    assert.equal(job.body.job.sceneId, fixture.scene.id);
  });

  await t.test("mock completion enters quality_check and repeated poll is idempotent", async () => {
    const fixture = await createQualityCheckScene("mock-idempotent@example.com");
    const beforeScene = fixture.scene;

    const repeated = await api(`/api/jobs/${fixture.job.id}`, {
      ownerId: fixture.ownerId,
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.job.status, "done");

    const afterScene = await readScene(fixture.ownerId, fixture.project.id, beforeScene.id);
    assert.equal(afterScene.status, "quality_check");
    assert.equal(afterScene.outputVideoUri, beforeScene.outputVideoUri);
    assert.equal(afterScene.endFrameUri, beforeScene.endFrameUri);
  });

  await t.test("concurrent mock completion polls converge on done and quality_check", async () => {
    const fixture = await createMockCompletionBoundary("qc-concurrent@example.com");
    const responses = await Promise.all([
      api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId }),
      api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId }),
    ]);

    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.equal(response.body.job.status, "done");
    }
    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
    assert.equal(
      scene.outputVideoUri,
      `mock://renders/${fixture.project.id}/${fixture.scene.id}.mp4`,
    );
    assert.equal(
      scene.endFrameUri,
      `mock://frames/${fixture.project.id}/${fixture.scene.id}-last.jpg`,
    );
  });

  await t.test("active extraction metadata is never serialized by the jobs API", async () => {
    const fixture = await createMockCompletionBoundary("qc-private-claim@example.com");
    await executeLocalSql(
      `UPDATE generation_jobs SET extraction_claim_token = 'private-claim-token', extraction_claim_kind = 'completion', extraction_claim_expires_at = '2099-01-01T00:00:00.000Z', extraction_failure_code = NULL, error_code = NULL, state_version = state_version + 1 WHERE id = '${sqlText(fixture.job.id)}';`,
    );

    const response = await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    assert.equal(response.status, 200);
    assert.equal(response.body.job.status, "running");
    assert.equal(response.body.job.errorCode, null);
    assert.equal(response.raw.includes("private-claim-token"), false);
    assert.equal(response.raw.includes("extractionClaim"), false);
    assert.equal(response.raw.includes("extractionFailure"), false);
    assert.equal(response.raw.includes("stateVersion"), false);
  });

  await t.test("scene-terminal job-running partial state reconciles without generation side effects", async () => {
    const fixture = await createQualityCheckScene("qc-partial-scene@example.com");
    await executeLocalSql(
      `UPDATE generation_jobs SET status = 'running', progress = 64 WHERE id = '${sqlText(fixture.job.id)}';`,
    );

    const reconciled = await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.job.status, "done");
    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
    assert.equal(scene.outputVideoUri, fixture.scene.outputVideoUri);
    assert.equal(scene.endFrameUri, fixture.scene.endFrameUri);
  });

  await t.test("job-done scene-active partial state is recoverable on a later poll", async () => {
    const fixture = await createMockCompletionBoundary("qc-partial-job@example.com");
    await executeLocalSql(
      `UPDATE generation_jobs SET status = 'done', progress = 100 WHERE id = '${sqlText(fixture.job.id)}';`,
    );

    const reconciled = await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.job.status, "done");
    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
    assert.ok(scene.outputVideoUri);
    assert.ok(scene.endFrameUri);
  });

  await t.test("partial extraction failure recovers output and remains idempotent", async () => {
    const fixture = await createMockCompletionBoundary("qc-partial-extraction@example.com");
    await executeLocalSql(
      `UPDATE generation_jobs SET status = 'failed', progress = 100, error_code = 'end_frame_extraction_failed' WHERE id = '${sqlText(fixture.job.id)}';`,
    );

    const reconciled = await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.job.status, "failed");
    assert.equal(reconciled.body.job.errorCode, "end_frame_extraction_failed");
    const failedScene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(failedScene.status, "failed");
    assert.equal(
      failedScene.outputVideoUri,
      `mock://renders/${fixture.project.id}/${fixture.scene.id}.mp4`,
    );
    assert.equal(failedScene.endFrameUri, null);

    const repeated = await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.job.status, "failed");
    const repeatedScene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.deepEqual(repeatedScene, failedScene);
  });

  await t.test("non-owner receives 404", async () => {
    const fixture = await createQualityCheckScene("qc-owned@example.com");
    const response = await qc(fixture.scene.id, "different-owner@example.com", {
      decision: "approve",
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "scene_not_found");

    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
  });

  await t.test("approve returns 409 when quality_check media is incomplete", async () => {
    const fixture = await createQualityCheckScene("qc-missing-media@example.com");
    await executeLocalSql(
      `UPDATE scenes SET end_frame_key = NULL WHERE id = '${sqlText(fixture.scene.id)}';`,
    );

    const response = await qc(fixture.scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "scene_media_not_ready");

    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
    assert.ok(scene.outputVideoUri);
    assert.equal(scene.endFrameUri, null);
  });

  await t.test("approve preserves media, second approve and later reject return 409", async () => {
    const fixture = await createQualityCheckScene("qc-approve@example.com");
    const outputVideoUri = fixture.scene.outputVideoUri;
    const endFrameUri = fixture.scene.endFrameUri;

    const approved = await qc(fixture.scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.scene.status, "approved");
    assert.equal(approved.body.scene.outputVideoUri, outputVideoUri);
    assert.equal(approved.body.scene.endFrameUri, endFrameUri);

    const secondApprove = await qc(fixture.scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(secondApprove.status, 409);
    assert.equal(secondApprove.body.error, "invalid_scene_transition");

    const rejectAfterApprove = await qc(fixture.scene.id, fixture.ownerId, { decision: "reject" });
    assert.equal(rejectAfterApprove.status, 409);
    assert.equal(rejectAfterApprove.body.error, "invalid_scene_transition");

    await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    const sceneAfterPoll = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(sceneAfterPoll.status, "approved");
  });

  await t.test("reject preserves media and reason is neither persisted nor returned", async () => {
    const fixture = await createQualityCheckScene("qc-reject@example.com");
    const reason = "  visible hand deformation  ";
    const rejected = await qc(fixture.scene.id, fixture.ownerId, {
      decision: "reject",
      reason,
    });

    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.scene.status, "rejected");
    assert.equal(rejected.body.scene.outputVideoUri, fixture.scene.outputVideoUri);
    assert.equal(rejected.body.scene.endFrameUri, fixture.scene.endFrameUri);
    assert.equal(rejected.body.qc.reasonPersisted, false);
    assert.equal(JSON.stringify(rejected.body).includes(reason.trim()), false);
    assert.equal(runtimeOutput.includes(reason.trim()), false);
    assert.equal("reason" in rejected.body.scene, false);

    const secondReject = await qc(fixture.scene.id, fixture.ownerId, { decision: "reject" });
    assert.equal(secondReject.status, 409);
    assert.equal(secondReject.body.error, "invalid_scene_transition");

    const approveAfterReject = await qc(fixture.scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(approveAfterReject.status, 409);
    assert.equal(approveAfterReject.body.error, "invalid_scene_transition");

    await api(`/api/jobs/${fixture.job.id}`, { ownerId: fixture.ownerId });
    const sceneAfterPoll = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(sceneAfterPoll.status, "rejected");
    assert.equal("reason" in sceneAfterPoll, false);
  });

  await t.test("approve and reject reject a scene outside quality_check", async () => {
    const fixture = await createStoryboard("qc-invalid-state@example.com");
    const scene = fixture.scenes[0];

    const approve = await qc(scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(approve.status, 409);
    assert.equal(approve.body.error, "invalid_scene_transition");

    const reject = await qc(scene.id, fixture.ownerId, { decision: "reject" });
    assert.equal(reject.status, 409);
    assert.equal(reject.body.error, "invalid_scene_transition");
  });

  await t.test("reject reason longer than 500 characters returns 400 without mutation", async () => {
    const fixture = await createQualityCheckScene("qc-long-reason@example.com");
    const response = await qc(fixture.scene.id, fixture.ownerId, {
      decision: "reject",
      reason: "x".repeat(501),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "invalid_qc_payload");

    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
  });

  await t.test("owned scene media is private, redirects mock output, and supports playback reads", async () => {
    const fixture = await createQualityCheckScene("scene-media@example.com");
    const mediaUrl = `${baseUrl}/api/scenes/${fixture.scene.id}/media`;

    const unauthenticated = await fetch(mediaUrl, { redirect: "manual" });
    assert.equal(unauthenticated.status, 401);

    const nonOwner = await fetch(mediaUrl, {
      headers: { "oai-authenticated-user-email": "scene-media-other@example.com" },
      redirect: "manual",
    });
    assert.equal(nonOwner.status, 404);

    const malformedRangeRedirect = await fetch(mediaUrl, {
      headers: {
        "oai-authenticated-user-email": fixture.ownerId,
        range: "bytes=0-1,2-3",
      },
      redirect: "manual",
    });
    assert.equal(malformedRangeRedirect.status, 307);
    assert.match(
      malformedRangeRedirect.headers.get("location") ?? "",
      /\/mock\/sceneflow-preview\.mp4$/,
    );

    const redirect = await fetch(mediaUrl, {
      headers: { "oai-authenticated-user-email": fixture.ownerId },
      redirect: "manual",
    });
    assert.equal(redirect.status, 307);
    assert.match(redirect.headers.get("location") ?? "", /\/mock\/sceneflow-preview\.mp4$/);

    const playable = await fetch(mediaUrl, {
      headers: {
        "oai-authenticated-user-email": fixture.ownerId,
        range: "bytes=0-31",
      },
    });
    assert.ok(playable.status === 200 || playable.status === 206);
    assert.match(playable.headers.get("content-type") ?? "", /video\/mp4/);
    assert.ok((await playable.arrayBuffer()).byteLength > 0);
  });

  await t.test("concurrent generation requests share one job and one credit debit", async () => {
    const fixture = await createStoryboard("generation-admission@example.com");
    const target = fixture.scenes[0];

    const responses = await Promise.all([
      api(`/api/scenes/${target.id}/generate`, { method: "POST", ownerId: fixture.ownerId }),
      api(`/api/scenes/${target.id}/generate`, { method: "POST", ownerId: fixture.ownerId }),
    ]);

    for (const response of responses) assert.equal(response.status, 202);
    assert.equal(responses[0].body.job.id, responses[1].body.job.id);
    assert.equal(responses[0].body.job.attempt, 1);
    assert.equal(responses[1].body.job.attempt, 1);
    assert.equal(responses.filter((response) => response.body.credits?.charged === 4).length, 1);
  });

  await t.test("quality_check cannot be generated again before a QC decision", async () => {
    const fixture = await createQualityCheckScene("generation-qc-gate@example.com");

    const response = await api(`/api/scenes/${fixture.scene.id}/generate`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error, "scene_requires_qc_decision");
    const scene = await readScene(fixture.ownerId, fixture.project.id, fixture.scene.id);
    assert.equal(scene.status, "quality_check");
  });

  await t.test("an active generation job blocks every other scene in the project", async () => {
    const fixture = await createStoryboard("generation-project-guard@example.com");
    const first = fixture.scenes[0];
    const second = fixture.scenes[1];
    await executeLocalSql(
      `UPDATE scenes SET status = 'planned', depends_on_scene_id = NULL WHERE id = '${sqlText(second.id)}';`,
    );
    const admitted = await api(`/api/scenes/${first.id}/generate`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });
    assert.equal(admitted.status, 202);

    const blocked = await api(`/api/scenes/${second.id}/generate`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "project_generation_in_progress");
  });

  await t.test("regeneration increments attempt and invalidates downstream only after submit", async () => {
    const fixture = await createStoryboard("generation-regenerate@example.com");
    const first = await generateFixtureSceneToQualityCheck(fixture, fixture.scenes[0]);
    const firstApproval = await qc(first.scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(firstApproval.status, 200);
    const second = await generateFixtureSceneToQualityCheck(fixture, fixture.scenes[1]);
    const secondApproval = await qc(second.scene.id, fixture.ownerId, { decision: "approve" });
    assert.equal(secondApproval.status, 200);
    const third = await generateFixtureSceneToQualityCheck(fixture, fixture.scenes[2]);
    assert.equal(third.scene.status, "quality_check");

    const regenerated = await api(`/api/scenes/${first.scene.id}/generate`, {
      method: "POST",
      ownerId: fixture.ownerId,
    });
    assert.equal(regenerated.status, 202);
    assert.equal(regenerated.body.job.attempt, 2);

    const project = await api(`/api/projects/${fixture.project.id}`, { ownerId: fixture.ownerId });
    assert.equal(project.status, 200);
    const scenes = project.body.scenes;
    assert.equal(scenes[0].status, "queued");
    assert.equal(scenes[0].outputVideoUri, null);
    assert.equal(scenes[0].endFrameUri, null);
    for (const downstream of scenes.slice(1)) {
      assert.equal(downstream.status, "waiting_previous");
      assert.equal(downstream.startFrameUri, null);
      assert.equal(downstream.outputVideoUri, null);
      assert.equal(downstream.endFrameUri, null);
    }
  });

  await t.test("generation and final render guards are symmetric", async () => {
    const generationFixture = await createStoryboard("render-generation-guard@example.com");
    const generated = await api(`/api/scenes/${generationFixture.scenes[0].id}/generate`, {
      method: "POST",
      ownerId: generationFixture.ownerId,
    });
    assert.equal(generated.status, 202);
    const blockedRender = await api(`/api/projects/${generationFixture.project.id}/render`, {
      method: "POST",
      ownerId: generationFixture.ownerId,
    });
    assert.equal(blockedRender.status, 409);
    assert.equal(blockedRender.body.error, "generation_in_progress");

    const renderFixture = await createStoryboard("generation-render-guard@example.com");
    const renderId = `render_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await executeLocalSql(
      `INSERT INTO final_renders (id, project_id, status, manifest_json, output_video_key, duration_seconds, created_at, updated_at) VALUES ('${sqlText(renderId)}', '${sqlText(renderFixture.project.id)}', 'queued', '{}', NULL, NULL, '${sqlText(now)}', '${sqlText(now)}');`,
    );
    const blockedGeneration = await api(`/api/scenes/${renderFixture.scenes[0].id}/generate`, {
      method: "POST",
      ownerId: renderFixture.ownerId,
    });
    assert.equal(blockedGeneration.status, 409);
    assert.equal(blockedGeneration.body.error, "project_render_in_progress");
  });

  await t.test("concurrent final-render requests share one reservation", async () => {
    const fixture = await createStoryboard("render-admission@example.com");
    for (const scene of fixture.scenes) {
      const completed = await generateFixtureSceneToQualityCheck(fixture, scene);
      const approved = await qc(completed.scene.id, fixture.ownerId, { decision: "approve" });
      assert.equal(approved.status, 200);
    }

    const responses = await Promise.all([
      api(`/api/projects/${fixture.project.id}/render`, {
        method: "POST",
        ownerId: fixture.ownerId,
      }),
      api(`/api/projects/${fixture.project.id}/render`, {
        method: "POST",
        ownerId: fixture.ownerId,
      }),
    ]);

    for (const response of responses) assert.equal(response.status, 202);
    assert.equal(responses[0].body.render.id, responses[1].body.render.id);
    assert.equal(responses.filter((response) => response.body.reused === true).length, 1);
  });
});

async function createQualityCheckScene(ownerId) {
  const fixture = await createStoryboard(ownerId);
  const scene = fixture.scenes[0];
  const generated = await api(`/api/scenes/${scene.id}/generate`, {
    method: "POST",
    ownerId,
  });
  assert.equal(generated.status, 202);

  let job = generated.body.job;
  for (let poll = 0; poll < 4 && job.status !== "done"; poll += 1) {
    const response = await api(`/api/jobs/${job.id}`, { ownerId });
    assert.equal(response.status, 200);
    job = response.body.job;
  }
  assert.equal(job.status, "done");

  const updatedScene = await readScene(ownerId, fixture.project.id, scene.id);
  assert.equal(updatedScene.status, "quality_check");
  assert.ok(updatedScene.outputVideoUri);
  assert.ok(updatedScene.endFrameUri);
  return { ...fixture, scene: updatedScene, job };
}

async function createMockCompletionBoundary(ownerId) {
  const fixture = await createStoryboard(ownerId);
  const scene = fixture.scenes[0];
  const generated = await api(`/api/scenes/${scene.id}/generate`, {
    method: "POST",
    ownerId,
  });
  assert.equal(generated.status, 202);
  let job = generated.body.job;
  for (let poll = 0; poll < 2; poll += 1) {
    const response = await api(`/api/jobs/${job.id}`, { ownerId });
    assert.equal(response.status, 200);
    job = response.body.job;
  }
  assert.equal(job.status, "running");
  assert.equal(job.progress, 64);
  const activeScene = await readScene(ownerId, fixture.project.id, scene.id);
  assert.equal(activeScene.status, "generating");
  return { ...fixture, scene: activeScene, job };
}

async function generateFixtureSceneToQualityCheck(fixture, scene) {
  const generated = await api(`/api/scenes/${scene.id}/generate`, {
    method: "POST",
    ownerId: fixture.ownerId,
  });
  assert.equal(generated.status, 202);
  let job = generated.body.job;
  for (let poll = 0; poll < 4 && job.status !== "done"; poll += 1) {
    const response = await api(`/api/jobs/${job.id}`, { ownerId: fixture.ownerId });
    assert.equal(response.status, 200);
    job = response.body.job;
  }
  assert.equal(job.status, "done");
  const updatedScene = await readScene(fixture.ownerId, fixture.project.id, scene.id);
  assert.equal(updatedScene.status, "quality_check");
  return { scene: updatedScene, job };
}

async function createStoryboard(ownerId = owner) {
  const project = await createProject(ownerId, concreteStoryBible);
  const storyboard = await api(`/api/projects/${project.id}/storyboard`, {
    method: "POST",
    ownerId,
  });
  assert.equal(storyboard.status, 201);
  return {
    ownerId,
    project,
    storyboard: storyboard.body.storyboard,
    scenes: storyboard.body.scenes,
  };
}

async function createProject(ownerId, storyBible) {
  const created = await api("/api/projects", {
    method: "POST",
    ownerId,
    body: {
      name: `QC ${crypto.randomUUID()}`,
      brief: "A small deterministic manual quality-control test project.",
      aspectRatio: "9:16",
      targetDurationSeconds: 30,
      model: "veo-3.1-lite",
      storyBible,
    },
  });
  assert.equal(
    created.status,
    201,
    `${JSON.stringify(created.body)}\nRuntime output:\n${runtimeOutput}`,
  );
  return created.body.project;
}

async function readScene(ownerId, projectId, sceneId) {
  const response = await api(`/api/projects/${projectId}`, { ownerId });
  assert.equal(response.status, 200);
  const scene = response.body.scenes.find((item) => item.id === sceneId);
  assert.ok(scene, `scene ${sceneId} must exist`);
  return scene;
}

function qc(sceneId, ownerId, body) {
  return api(`/api/scenes/${sceneId}/qc`, { method: "POST", ownerId, body });
}

async function executeLocalSql(command) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      "d1",
      "execute",
      "site-creator-d1",
      "--local",
      "--config",
      join(root, "dist", "server", "wrangler.json"),
      "--persist-to",
      stateDirectory,
      "--command",
      command,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: join(stateDirectory, "wrangler-d1.log"),
        WRANGLER_SEND_METRICS: "false",
      },
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await waitForRuntimeStability();
}

function sqlText(value) {
  return value.replaceAll("'", "''");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function api(path, options = {}) {
  const headers = new Headers();
  if (options.ownerId) headers.set("oai-authenticated-user-email", options.ownerId);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: requestBody,
      });
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      continue;
    }
    const text = await response.text();
    const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;
    if (response.status === 503 && !isJson && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      continue;
    }
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { status: response.status, body, raw: text, contentType: response.headers.get("content-type") };
  }
  throw new Error("Unreachable local HTTP retry state.");
}

async function waitForRuntimeStability() {
  const deadline = Date.now() + 15_000;
  let consecutiveSuccesses = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/credits`, {
        headers: { "oai-authenticated-user-email": "qc-runtime-stability@example.com" },
      });
      consecutiveSuccesses = response.status === 200 ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= 2) return;
    } catch {
      consecutiveSuccesses = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler did not stabilize after local D1 mutation.\n${runtimeOutput}`);
}

async function waitForRuntime() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null) {
      throw new Error(`Wrangler exited before startup.\n${runtimeOutput}`);
    }
    try {
      const headers = { "oai-authenticated-user-email": "qc-runtime-ready@example.com" };
      const credits = await fetch(`${baseUrl}/api/credits`, { headers });
      const projects = credits.status === 200
        ? await fetch(`${baseUrl}/api/projects`, { headers })
        : null;
      const warmWrite = projects?.status === 200
        ? await fetch(`${baseUrl}/api/projects`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              name: "QC runtime readiness",
              brief: "Initialize the isolated local D1 write path before assertions.",
              model: "veo-3.1-lite",
              storyBible: concreteStoryBible,
            }),
          })
        : null;
      const qcPreload = warmWrite?.status === 201
        ? await fetch(`${baseUrl}/api/scenes/scene_runtime_preload/qc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: "approve" }),
          })
        : null;
      const stableWrite = qcPreload?.status === 401
        ? await fetch(`${baseUrl}/api/projects`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              name: "QC runtime stable write",
              brief: "Confirm the local runtime is stable after loading the QC route.",
              model: "veo-3.1-lite",
              storyBible: concreteStoryBible,
            }),
          })
        : null;
      if (stableWrite?.status === 201) return;
    } catch {
      // Local runtime or its D1 binding is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Wrangler.\n${runtimeOutput}`);
}

function waitForExit(milliseconds) {
  if (!runtime || runtime.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => runtime.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

async function removeStateDirectory() {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(stateDirectory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
