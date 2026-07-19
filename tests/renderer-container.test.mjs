import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

async function readProjectFile(path) {
  return readFile(join(root, path), "utf8");
}

test("renderer image includes every local ESM module imported by the server", async () => {
  const [dockerfile, server] = await Promise.all([
    readProjectFile("services/renderer/Dockerfile"),
    readProjectFile("services/renderer/server.mjs"),
  ]);
  const localModules = [...server.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(
    ([, module]) => module,
  );

  assert.ok(localModules.length > 0, "renderer server must expose its local module imports");
  for (const modulePath of localModules) {
    assert.match(
      dockerfile,
      new RegExp(`\\b${escapeRegExp(modulePath)}\\b`),
      `renderer image must copy ${modulePath}`,
    );
  }
});

test("renderer image uses the supported project runtime and a non-root user", async () => {
  const dockerfile = await readProjectFile("services/renderer/Dockerfile");

  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.match(dockerfile, /^USER node$/m);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
