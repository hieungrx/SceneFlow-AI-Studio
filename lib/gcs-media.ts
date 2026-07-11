import { env } from "cloudflare:workers";
import { getGoogleAccessToken } from "./google-auth";

export async function fetchPrivateGcsObject(uri: string, range?: string | null): Promise<Response> {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error("Invalid private GCS media URI.");
  const runtime = env as unknown as Record<string, string | undefined>;
  const token = await getGoogleAccessToken({
    accessToken: runtime.GOOGLE_ACCESS_TOKEN,
    serviceAccountEmail: runtime.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    serviceAccountPrivateKey: runtime.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  });
  const bucket = encodeURIComponent(match[1]);
  const object = encodeURIComponent(match[2]);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (range) headers.set("range", range);
  return fetch(`https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${object}?alt=media`, {
    headers,
  });
}
