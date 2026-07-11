import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getOwnedProject, listOwnedScenes } from "../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  return NextResponse.json({ project, scenes: await listOwnedScenes(user.email, id) });
}
