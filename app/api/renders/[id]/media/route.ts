import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { fetchPrivateGcsObject } from "../../../../../lib/gcs-media";
import {
  createInvalidMediaRangeResponse,
  createMediaUpstreamFailedResponse,
  createPrivateVideoResponse,
  parseSingleByteRange,
} from "../../../../../lib/private-video-response";
import { getOwnedRender } from "../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const render = await getOwnedRender(user.email, id);
  if (!render) return NextResponse.json({ error: "render_not_found" }, { status: 404 });
  if (render.outputVideoUri?.startsWith("/mock/")) {
    return NextResponse.redirect(new URL(render.outputVideoUri, request.url), 307);
  }
  if (!render.outputVideoUri?.startsWith("gs://")) {
    return NextResponse.json({ error: "render_media_not_ready" }, { status: 409 });
  }

  const parsedRange = parseSingleByteRange(request.headers.get("range"));
  if (!parsedRange.ok) return createInvalidMediaRangeResponse();

  try {
    const upstream = await fetchPrivateGcsObject(
      render.outputVideoUri,
      parsedRange.range?.headerValue,
    );
    return await createPrivateVideoResponse(upstream, {
      range: parsedRange.range,
      filename: `sceneflow-${render.id}.mp4`,
    });
  } catch {
    return createMediaUpstreamFailedResponse();
  }
}
