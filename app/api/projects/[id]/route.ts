import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import {
  findOwnedActiveJobForProject,
  findOwnedActiveRenderForProject,
  getOwnedProject,
  hasOwnedExecutionHistory,
  listOwnedScenes,
  updateOwnedProjectStoryBible,
} from "../../../../lib/repository";
import { parseConcreteStoryBible } from "../../../../lib/story-bible";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  return NextResponse.json({ project, scenes: await listOwnedScenes(user.email, id) });
}

export async function PATCH(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const storyBibleResult = parseConcreteStoryBible(body?.storyBible);
  if (!storyBibleResult.storyBible) {
    return NextResponse.json(
      { error: "invalid_story_bible", issues: storyBibleResult.issues },
      { status: 400 },
    );
  }

  const [activeJob, activeRender, hasExecutionHistory] = await Promise.all([
    findOwnedActiveJobForProject(user.email, id),
    findOwnedActiveRenderForProject(user.email, id),
    hasOwnedExecutionHistory(user.email, id),
  ]);
  if (activeJob || activeRender) {
    return NextResponse.json({ error: "project_operation_in_progress" }, { status: 409 });
  }
  if (hasExecutionHistory) {
    return NextResponse.json({ error: "story_bible_update_has_execution_history" }, { status: 409 });
  }

  const updated = await updateOwnedProjectStoryBible(
    user.email,
    id,
    storyBibleResult.storyBible,
  );
  if (!updated) {
    return NextResponse.json({ error: "story_bible_update_conflict" }, { status: 409 });
  }
  return NextResponse.json({ project: updated });
}
