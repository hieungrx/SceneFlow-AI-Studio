import { env } from "cloudflare:workers";
import { getGoogleAccessToken } from "./google-auth";

type GcsLocation = {
  bucket: string;
  object: string;
};

export async function fetchPrivateGcsObject(
  uri: string,
  range?: string | null,
  generation?: string | null,
): Promise<Response> {
  const location = parseGcsLocation(uri);
  const runtime = env as unknown as Record<string, string | undefined>;
  const token = await getGoogleAccessToken({
    accessToken: runtime.GOOGLE_ACCESS_TOKEN,
    serviceAccountEmail: runtime.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: runtime.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  });
  const bucket = encodeURIComponent(location.bucket);
  const object = encodeURIComponent(location.object);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (range) headers.set("range", range);
  const url = new URL(`https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${object}`);
  url.searchParams.set("alt", "media");
  if (generation) url.searchParams.set("ifGenerationMatch", generation);
  return fetch(url, { headers });
}

export async function fetchPrivateGcsObjectMetadata(uri: string): Promise<Response> {
  const location = parseGcsLocation(uri);
  const runtime = env as unknown as Record<string, string | undefined>;
  const token = await getGoogleAccessToken({
    accessToken: runtime.GOOGLE_ACCESS_TOKEN,
    serviceAccountEmail: runtime.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: runtime.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  });
  const bucket = encodeURIComponent(location.bucket);
  const object = encodeURIComponent(location.object);
  return fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

export function parseGcsLocation(uri: string): GcsLocation {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error("Invalid private GCS media URI.");
  return { bucket: match[1], object: match[2] };
}
