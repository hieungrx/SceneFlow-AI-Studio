import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  createOwnedStoryboardVersion,
  findOwnedActiveJobForProject,
  findOwnedActiveRenderForProject,
  getOwnedProject,
  hasOwnedExecutionHistory,
  listOwnedScenes,
  listOwnedPromptVersions,
  listOwnedStoryboards,
} from "../../../../../lib/repository";
import {
  compileScenePrompt,
  SCENE_PROMPT_COMPILER_VERSION,
} from "../../../../../lib/prompt-compiler";
import {
  planDeterministicStoryboard,
  STORYBOARD_PLANNER_VERSION,
} from "../../../../../lib/storyboard-planner";
import type {
  PromptVersion,
  Scene,
  StoryboardCompilation,
} from "../../../../../lib/types";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const [storyboards, promptVersions] = await Promise.all([
    listOwnedStoryboards(user.email, id),
    listOwnedPromptVersions(user.email, id),
  ]);
  return NextResponse.json({
    storyboards: storyboards ?? [],
    promptVersions: promptVersions ?? [],
  });
}

export async function POST(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const allowApprovedReplacement = body?.confirmApprovedReplacement === true;
  const [currentScenes, activeJob, activeRender, hasExecutionHistory] = await Promise.all([
    listOwnedScenes(user.email, id),
    findOwnedActiveJobForProject(user.email, id),
    findOwnedActiveRenderForProject(user.email, id),
    hasOwnedExecutionHistory(user.email, id),
  ]);
  if (activeJob || activeRender) {
    return NextResponse.json({ error: "project_operation_in_progress" }, { status: 409 });
  }
  if (
    currentScenes.some((scene) => scene.status === "approved") &&
    !allowApprovedReplacement
  ) {
    return NextResponse.json(
      { error: "approved_storyboard_requires_confirmation" },
      { status: 409 },
    );
  }
  if (currentScenes.length > 0 && hasExecutionHistory) {
    return NextResponse.json(
      { error: "storyboard_replan_has_execution_history" },
      { status: 409 },
    );
  }

  const storyboardId = `storyboard_${crypto.randomUUID()}`;
  const plannedScenes = planDeterministicStoryboard(project);
  const createdAt = new Date().toISOString();
  const promptVersions: PromptVersion[] = [];
  const sceneList: Scene[] = plannedScenes.map((planned, index) => {
    const compilation = compileScenePrompt(planned.contract);
    const promptVersionId = `prompt_${crypto.randomUUID()}`;
    promptVersions.push({
      id: promptVersionId,
      projectId: project.id,
      sceneId: planned.contract.sceneId,
      version: 1,
      rawPrompt: `${planned.contract.goal}\n${planned.contract.primaryAction}`,
      optimizedPrompt: compilation.prompt,
      assumptions: [
        `Storyboard planned by ${STORYBOARD_PLANNER_VERSION}.`,
        "No LLM or paid provider call was used.",
      ],
      compilerVersion: compilation.compilerVersion,
      generationMode: compilation.generationMode,
      lintIssues: compilation.lintIssues,
      accepted: true,
      createdAt,
    });
    return {
      id: planned.contract.sceneId,
      projectId: project.id,
      storyboardId,
      storyboardVersion: null,
      sceneContract: planned.contract,
      promptVersionId,
      promptVersion: 1,
      promptCompilerVersion: SCENE_PROMPT_COMPILER_VERSION,
      sceneIndex: planned.contract.sceneIndex,
      title: planned.title,
      durationSeconds: 8,
      status: index === 0 ? "planned" : "waiting_previous",
      startState: planned.contract.startState.compositionState,
      action: planned.contract.primaryAction,
      endState: planned.contract.endState.compositionState,
      prompt: compilation.prompt,
      negativePrompt: compilation.negativePrompt,
      transition: planned.transition,
      dependsOnSceneId: index === 0 ? null : plannedScenes[index - 1].contract.sceneId,
      startFrameUri: null,
      endFrameUri: null,
      outputVideoUri: null,
      qualityScore: null,
    };
  });
  const compiled: StoryboardCompilation = {
    schemaVersion: 1,
    planner: {
      kind: "deterministic_rules",
      version: STORYBOARD_PLANNER_VERSION,
    },
    storyBible: {
      ...project.storyBible,
      mustAvoid: [...project.storyBible.mustAvoid],
    },
    sceneContracts: plannedScenes.map((planned) => planned.contract),
  };
  const saved = await createOwnedStoryboardVersion(user.email, project.id, {
    id: storyboardId,
    sourcePrompt: project.brief,
    compiled,
    scenes: sceneList,
    promptVersions,
    allowApprovedReplacement,
  });
  if (!saved) {
    return NextResponse.json({ error: "storyboard_replan_conflict" }, { status: 409 });
  }
  return NextResponse.json(
    {
      storyboard: saved.storyboard,
      scenes: saved.scenes,
      planner: {
        kind: "deterministic_rules",
        version: STORYBOARD_PLANNER_VERSION,
      },
    },
    { status: 201 },
  );
}
