import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { fetchPrivateGcsObject } from "../../../../../lib/gcs-media";
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

  try {
    const upstream = await fetchPrivateGcsObject(render.outputVideoUri, request.headers.get("range"));
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: "media_upstream_failed" }, { status: 502 });
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="sceneflow-${render.id}.mp4"`,
      "x-content-type-options": "nosniff",
    });
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return NextResponse.json(
      { error: "media_proxy_failed", message: error instanceof Error ? error.message : "Media proxy failed" },
      { status: 502 },
    );
  }
}
