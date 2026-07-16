import { env } from "cloudflare:workers";
import type { RenderManifest } from "./types";
import { callRendererHttp } from "./renderer-http";
import {
  fetchPrivateGcsObject,
  fetchPrivateGcsObjectMetadata,
  parseGcsLocation,
} from "./gcs-media";

type RendererConfig = {
  url: string;
  secret: string;
  outputGcsPrefix: string;
};

type GcsObjectMetadata = {
  bucket?: unknown;
  name?: unknown;
  size?: unknown;
  contentType?: unknown;
  generation?: unknown;
  etag?: unknown;
  metadata?: unknown;
};

type ExpectedContinuityArtifact = {
  uri: string;
  projectId: string;
  sceneId: string;
  generationJobId: string;
  operationId: string;
  inputUriSha256: string;
};

export type ExistingEndFrameResult =
  | { status: "ready"; endFrameUri: string; generation: string }
  | { status: "missing" }
  | { status: "invalid"; errorCode: "invalid_extraction_artifact" };

export type EndFrameExtractionResult =
  | { status: "completed"; endFrameUri: string }
  | { status: "processing" }
  | { status: "failed"; errorCode: string };

export async function extractLastFrame(
  inputUri: string,
  projectId: string,
  sceneId: string,
  versionId: string,
): Promise<EndFrameExtractionResult> {
  const config = rendererConfig();
  if (!config) return { status: "failed", errorCode: "renderer_not_configured" };
  const outputGcsUri = lastFrameOutputUri(config, projectId, sceneId, versionId);
  const operationId = extractionOperationId(versionId);
  const body = await callRendererHttp(
    config.url,
    config.secret,
    "/extract-last-frame",
    {
      requestVersion: 1,
      operationId,
      projectId,
      sceneId,
      generationJobId: versionId,
      videoUri: inputUri,
      format: "jpeg",
      expectedContentType: "image/jpeg",
      outputGcsUri,
    },
    { requestId: versionId, expectedOutputUri: outputGcsUri },
  );
  if (body.state === "processing") return { status: "processing" };
  if (body.state === "failed") {
    return { status: "failed", errorCode: body.error?.code ?? "end_frame_extraction_failed" };
  }
  return { status: "completed", endFrameUri: body.outputUri ?? outputGcsUri };
}

export async function findExistingLastFrame(
  inputUri: string,
  projectId: string,
  sceneId: string,
  versionId: string,
): Promise<ExistingEndFrameResult> {
  const config = rendererConfig();
  if (!config) return { status: "invalid", errorCode: "invalid_extraction_artifact" };
  const outputGcsUri = lastFrameOutputUri(config, projectId, sceneId, versionId);
  const response = await fetchPrivateGcsObjectMetadata(outputGcsUri);
  if (response.status === 404) {
    await response.body?.cancel();
    return { status: "missing" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Unable to check extracted frame output (${response.status}).`);
  }
  const metadata = (await response.json().catch(() => null)) as GcsObjectMetadata | null;
  const expected: ExpectedContinuityArtifact = {
    uri: outputGcsUri,
    projectId,
    sceneId,
    generationJobId: versionId,
    operationId: extractionOperationId(versionId),
    inputUriSha256: await sha256Hex(inputUri),
  };
  const validated = validateContinuityArtifactMetadata(metadata, expected);
  if (!validated) return { status: "invalid", errorCode: "invalid_extraction_artifact" };

  const firstBytes = await readArtifactRange(
    outputGcsUri,
    "bytes=0-2",
    validated.generation,
  );
  const lastByteOffset = BigInt(validated.size) - 1n;
  const lastBytes = await readArtifactRange(
    outputGcsUri,
    `bytes=${lastByteOffset - 1n}-${lastByteOffset}`,
    validated.generation,
  );
  if (
    firstBytes.length < 3 ||
    firstBytes[0] !== 0xff ||
    firstBytes[1] !== 0xd8 ||
    firstBytes[2] !== 0xff ||
    lastBytes.length < 2 ||
    lastBytes.at(-2) !== 0xff ||
    lastBytes.at(-1) !== 0xd9
  ) {
    return { status: "invalid", errorCode: "invalid_extraction_artifact" };
  }
  return { status: "ready", endFrameUri: outputGcsUri, generation: validated.generation };
}

export function validateContinuityArtifactMetadata(
  value: GcsObjectMetadata | null,
  expected: ExpectedContinuityArtifact,
): { generation: string; size: string } | null {
  if (!value || typeof value !== "object") return null;
  const location = parseGcsLocation(expected.uri);
  if (value.bucket !== location.bucket || value.name !== location.object) return null;
  if (value.contentType !== "image/jpeg") return null;
  if (typeof value.size !== "string" || !/^[1-9]\d*$/.test(value.size)) return null;
  if (BigInt(value.size) < 5n) return null;
  if (typeof value.generation !== "string" || !/^[1-9]\d*$/.test(value.generation)) return null;
  if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) return null;
  const metadata = value.metadata as Record<string, unknown>;
  const bindings: Record<string, string> = {
    "veo3flow-project-id": expected.projectId,
    "veo3flow-scene-id": expected.sceneId,
    "veo3flow-job-id": expected.generationJobId,
    "veo3flow-operation-id": expected.operationId,
    "veo3flow-artifact-kind": "continuity-last-frame",
    "veo3flow-request-version": "1",
    "veo3flow-input-uri-sha256": expected.inputUriSha256,
  };
  for (const [key, expectedValue] of Object.entries(bindings)) {
    if (metadata[key] !== expectedValue) return null;
  }
  return { generation: value.generation, size: value.size };
}

export async function dispatchFinalRender(input: {
  renderId: string;
  projectId: string;
  manifest: RenderManifest;
}): Promise<{ outputUri: string; durationSeconds: number | null } | null> {
  const config = rendererConfig();
  if (!config) return null;
  const outputGcsUri = `${config.outputGcsPrefix}/projects/${input.projectId}/final/${input.renderId}.mp4`;
  const transitionDuration = Math.max(
    0,
    ...input.manifest.scenes.map((scene) => scene.transitionDurationSeconds),
  );
  const body = await callRendererHttp(
    config.url,
    config.secret,
    "/render",
    {
      clips: input.manifest.scenes.map((scene) => ({ uri: scene.sourceUri })),
      width: input.manifest.output.width,
      height: input.manifest.output.height,
      fps: input.manifest.output.fps,
      includeAudio: true,
      transition: {
        type: transitionDuration > 0 ? "fade" : "cut",
        durationSeconds: transitionDuration,
      },
      crf: 20,
      preset: "veryfast",
      outputGcsUri,
    },
    { requestId: input.renderId, expectedOutputUri: outputGcsUri },
  );
  return {
    outputUri: body.outputUri ?? outputGcsUri,
    durationSeconds: body.output?.durationSeconds ?? null,
  };
}

function rendererConfig(): RendererConfig | null {
  const runtime = env as unknown as Record<string, string | undefined>;
  const outputGcsPrefix = runtime.RENDER_OUTPUT_GCS_URI || runtime.VEO_OUTPUT_GCS_URI;
  if (!runtime.RENDER_SERVICE_URL || !runtime.RENDER_SERVICE_SECRET || !outputGcsPrefix) return null;
  if (!/^gs:\/\/[a-z0-9][a-z0-9._-]{1,221}[a-z0-9](?:\/.*)?$/i.test(outputGcsPrefix)) {
    throw new Error("RENDER_OUTPUT_GCS_URI must be a valid gs:// bucket prefix.");
  }
  return {
    url: runtime.RENDER_SERVICE_URL.replace(/\/+$/, ""),
    secret: runtime.RENDER_SERVICE_SECRET,
    outputGcsPrefix: outputGcsPrefix.replace(/\/+$/, ""),
  };
}

function lastFrameOutputUri(
  config: RendererConfig,
  projectId: string,
  sceneId: string,
  versionId: string,
): string {
  return `${config.outputGcsPrefix}/projects/${projectId}/frames/${sceneId}-${versionId}-last.jpg`;
}

export function extractionOperationId(generationJobId: string): string {
  return `extract-last-frame:v1:${generationJobId}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readArtifactRange(
  uri: string,
  range: string,
  generation: string,
): Promise<Uint8Array> {
  const response = await fetchPrivateGcsObject(uri, range, generation);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Unable to validate extracted frame output (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 200 && range.startsWith("bytes=-")) return bytes;
  if (response.status === 200 && range !== "bytes=0-2") return bytes.slice(-2);
  return bytes;
}
