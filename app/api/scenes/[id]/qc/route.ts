import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import {
  getOwnedScene,
  transitionOwnedSceneFromStatus,
} from "../../../../../lib/repository";
import {
  parseQcRequest,
  qcSceneTransition,
} from "../../../../../lib/scene-workflow";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const input = parseQcRequest(body);
  if (!input) return NextResponse.json({ error: "invalid_qc_payload" }, { status: 400 });

  const { id } = await params;
  const scene = await getOwnedScene(user.email, id);
  if (!scene) return NextResponse.json({ error: "scene_not_found" }, { status: 404 });

  const transition = qcSceneTransition(scene, input.decision);
  if (!transition.ok) {
    return NextResponse.json({ error: transition.error }, { status: 409 });
  }

  const updated = await transitionOwnedSceneFromStatus(
    user.email,
    scene.id,
    "quality_check",
    transition.patch,
  );
  if (!updated) {
    return NextResponse.json({ error: "invalid_scene_transition" }, { status: 409 });
  }

  return NextResponse.json({
    scene: updated,
    qc: {
      decision: input.decision,
      ...(input.decision === "reject" ? { reasonPersisted: false } : {}),
    },
  });
}
