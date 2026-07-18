import { env } from "cloudflare:workers";

export async function putProjectAsset(input: {
  key: string;
  body: Blob;
  contentType: string;
  ownerId: string;
  projectId: string;
  kind: string;
  originalName: string;
}): Promise<void> {
  if (!env.MEDIA) throw new Error("R2 binding `MEDIA` is unavailable.");
  await env.MEDIA.put(input.key, input.body, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: {
      ownerId: input.ownerId,
      projectId: input.projectId,
      kind: input.kind,
      originalName: input.originalName,
    },
  });
}

export async function deleteProjectAsset(key: string): Promise<void> {
  if (!env.MEDIA) throw new Error("R2 binding `MEDIA` is unavailable.");
  await env.MEDIA.delete(key);
}
