import { env } from "cloudflare:workers";

export async function putProjectAsset(input: {
  key: string;
  bytes: ArrayBuffer;
  contentType: string;
  ownerId: string;
  projectId: string;
  kind: string;
  originalName: string;
}): Promise<void> {
  if (!env.MEDIA) throw new Error("R2 binding `MEDIA` is unavailable.");
  await env.MEDIA.put(input.key, input.bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: {
      ownerId: input.ownerId,
      projectId: input.projectId,
      kind: input.kind,
      originalName: input.originalName,
    },
  });
}
