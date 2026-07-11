import { env } from "cloudflare:workers";
import type { AspectRatio, JobStatus, VideoModel } from "./types";
import { getGoogleAccessToken } from "./google-auth";

export type SubmitVideoRequest = {
  projectId: string;
  sceneId: string;
  prompt: string;
  negativePrompt?: string;
  model: VideoModel;
  aspectRatio: AspectRatio;
  durationSeconds: 4 | 6 | 8;
  startFrameUri?: string | null;
  lastFrameUri?: string | null;
};

export type ProviderOperation = {
  operationId: string;
  status: JobStatus;
  progress: number;
  outputVideoUri: string | null;
  errorCode: string | null;
};

export interface VideoProvider {
  readonly name: "mock" | "google";
  submit(request: SubmitVideoRequest): Promise<ProviderOperation>;
  poll(operationId: string): Promise<ProviderOperation>;
  cancel(operationId: string): Promise<void>;
}

export class MockVeoProvider implements VideoProvider {
  readonly name = "mock" as const;

  async submit(request: SubmitVideoRequest): Promise<ProviderOperation> {
    return {
      operationId: `mock_${request.sceneId}_${crypto.randomUUID()}`,
      status: "queued",
      progress: 0,
      outputVideoUri: null,
      errorCode: null,
    };
  }

  async poll(operationId: string): Promise<ProviderOperation> {
    return { operationId, status: "running", progress: 64, outputVideoUri: null, errorCode: null };
  }

  async cancel(_operationId: string): Promise<void> {
    void _operationId;
    return;
  }
}

type GoogleConfig = {
  projectId: string;
  location: string;
  outputGcsUri: string;
  accessToken?: string;
  serviceAccountEmail?: string;
  serviceAccountPrivateKey?: string;
};

type GoogleOperationResponse = {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; status?: string };
  response?: { videos?: Array<{ gcsUri?: string; mimeType?: string }>; raiMediaFilteredCount?: number };
};

export class GoogleVeoProvider implements VideoProvider {
  readonly name = "google" as const;

  constructor(private readonly config: GoogleConfig) {}

  async submit(request: SubmitVideoRequest): Promise<ProviderOperation> {
    const modelId = googleModelId(request.model);
    const instance: Record<string, unknown> = { prompt: request.prompt };
    if (request.startFrameUri?.startsWith("gs://")) {
      instance.image = { gcsUri: request.startFrameUri, mimeType: imageMime(request.startFrameUri) };
    }
    if (request.lastFrameUri?.startsWith("gs://")) {
      instance.lastFrame = { gcsUri: request.lastFrameUri, mimeType: imageMime(request.lastFrameUri) };
    }

    const outputPrefix = `${this.config.outputGcsUri.replace(/\/+$/, "")}/${request.projectId}/${request.sceneId}/`;
    const response = await this.call(modelId, "predictLongRunning", {
      instances: [instance],
      parameters: {
        aspectRatio: request.aspectRatio,
        durationSeconds: request.durationSeconds,
        negativePrompt: request.negativePrompt,
        personGeneration: "allow_adult",
        resolution: "1080p",
        sampleCount: 1,
        storageUri: outputPrefix,
        generateAudio: true,
      },
    });
    if (!response.name) throw new Error("Veo did not return an operation name.");
    return {
      operationId: response.name,
      status: "queued",
      progress: 0,
      outputVideoUri: null,
      errorCode: null,
    };
  }

  async poll(operationId: string): Promise<ProviderOperation> {
    const modelId = modelIdFromOperation(operationId);
    const response = await this.call(modelId, "fetchPredictOperation", { operationName: operationId });
    if (response.error) {
      return {
        operationId,
        status: "failed",
        progress: 100,
        outputVideoUri: null,
        errorCode: response.error.status ?? String(response.error.code ?? "vertex_error"),
      };
    }
    const outputVideoUri = response.response?.videos?.[0]?.gcsUri ?? null;
    return {
      operationId,
      status: response.done ? (outputVideoUri ? "done" : "failed") : "running",
      progress: response.done ? 100 : 50,
      outputVideoUri,
      errorCode: response.done && !outputVideoUri ? "no_video_returned" : null,
    };
  }

  async cancel(_operationId: string): Promise<void> {
    // The publisher-model Veo REST contract does not currently expose a cancel
    // endpoint. We cancel locally and ignore a late provider result.
    void _operationId;
    return;
  }

  private async call(modelId: string, method: string, payload: unknown): Promise<GoogleOperationResponse> {
    const token = await getGoogleAccessToken(this.config);
    const endpoint = `https://${this.config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(this.config.location)}/publishers/google/models/${modelId}:${method}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const result = (await response.json().catch(() => ({}))) as GoogleOperationResponse;
    if (!response.ok) {
      const message = result.error?.message ?? `Vertex AI request failed (${response.status}).`;
      throw new Error(message);
    }
    return result;
  }
}

export function createVideoProvider(): VideoProvider {
  const runtime = env as unknown as Record<string, string | undefined>;
  if (runtime.VEO_PROVIDER !== "google") return new MockVeoProvider();
  if (!runtime.GOOGLE_CLOUD_PROJECT || !runtime.VEO_OUTPUT_GCS_URI) {
    throw new Error("Google Veo requires GOOGLE_CLOUD_PROJECT and VEO_OUTPUT_GCS_URI.");
  }
  return new GoogleVeoProvider({
    projectId: runtime.GOOGLE_CLOUD_PROJECT,
    location: runtime.GOOGLE_CLOUD_LOCATION || "us-central1",
    outputGcsUri: runtime.VEO_OUTPUT_GCS_URI,
    accessToken: runtime.GOOGLE_ACCESS_TOKEN,
    serviceAccountEmail: runtime.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: runtime.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  });
}

export function googleModelId(model: VideoModel): string {
  if (model === "veo-3.1-standard") return "veo-3.1-generate-001";
  if (model === "veo-3.1-fast") return "veo-3.1-fast-generate-001";
  return "veo-3.1-lite-generate-001";
}

function modelIdFromOperation(operationId: string): string {
  const match = operationId.match(/\/models\/([^/]+)\/operations\//);
  if (!match) throw new Error("Invalid Veo operation name.");
  return match[1];
}

function imageMime(uri: string): string {
  return uri.toLowerCase().endsWith(".png") ? "image/png" : uri.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
}
