import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { fetchPrivateGcsObject } from "../../../../../lib/gcs-media";
import {
  createInvalidMediaRangeResponse,
  createMediaUpstreamFailedResponse,
  createPrivateVideoResponse,
  parseSingleByteRange,
} from "../../../../../lib/private-video-response";
import { getOwnedScene } from "../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { id } = await params;
  const scene = await getOwnedScene(user.email, id);
  if (!scene) return NextResponse.json({ error: "scene_not_found" }, { status: 404 });
  if (scene.outputVideoUri?.startsWith("mock://") || scene.outputVideoUri?.startsWith("/mock/")) {
    return NextResponse.redirect(new URL("/mock/sceneflow-preview.mp4", request.url), 307);
  }
  if (!scene.outputVideoUri?.startsWith("gs://")) {
    return NextResponse.json({ error: "scene_media_not_ready" }, { status: 409 });
  }

  const parsedRange = parseSingleByteRange(request.headers.get("range"));
  if (!parsedRange.ok) return createInvalidMediaRangeResponse();

  try {
    const upstream = await fetchPrivateGcsObject(
      scene.outputVideoUri,
      parsedRange.range?.headerValue,
    );
    return await createPrivateVideoResponse(upstream, {
      range: parsedRange.range,
      filename: `sceneflow-scene-${scene.sceneIndex}.mp4`,
    });
  } catch {
    return createMediaUpstreamFailedResponse();
  }
}
