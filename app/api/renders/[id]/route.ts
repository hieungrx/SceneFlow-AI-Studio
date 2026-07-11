import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getOwnedRender } from "../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const render = await getOwnedRender(user.email, id);
  if (!render) return NextResponse.json({ error: "render_not_found" }, { status: 404 });
  return NextResponse.json({ render });
}
