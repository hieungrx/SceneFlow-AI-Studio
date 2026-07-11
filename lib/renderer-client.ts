import { env } from "cloudflare:workers";
import type { RenderManifest } from "./types";

type RendererResponse = {
  outputUri?: string;
  output?: {
    contentType?: string;
    bytes?: number;
    durationSeconds?: number;
    width?: number;
    height?: number;
  };
  error?: string;
  message?: string;
};

type RendererConfig = {
  url: string;
  secret: string;
  outputGcsPrefix: string;
};

export async function extractLastFrame(
  inputUri: string,
  projectId: string,
  sceneId: string,
  versionId: string,
): Promise<string | null> {
  const config = rendererConfig();
  if (!config) return null;
  const outputGcsUri = `${config.outputGcsPrefix}/projects/${projectId}/frames/${sceneId}-${versionId}-last.jpg`;
  const body = await callRenderer(config, "/extract-last-frame", {
    videoUri: inputUri,
    format: "jpeg",
    outputGcsUri,
  });
  return body.outputUri ?? outputGcsUri;
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
  const body = await callRenderer(config, "/render", {
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
  });
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

async function callRenderer(config: RendererConfig, path: string, payload: unknown): Promise<RendererResponse> {
  const response = await fetch(`${config.url}${path}`, {
    method: "POST",
    headers: {
      "x-renderer-token": config.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as RendererResponse;
  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `Renderer request failed (${response.status}).`);
  }
  return body;
}
