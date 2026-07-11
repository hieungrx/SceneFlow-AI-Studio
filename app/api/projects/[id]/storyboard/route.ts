import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { getOwnedProject, saveOwnedScenes } from "../../../../../lib/repository";
import { compileVideoPrompt } from "../../../../../lib/prompt-compiler";
import type { Scene } from "../../../../../lib/types";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Context) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await params;
  const project = await getOwnedProject(user.email, id);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  const beats = [
    ["Hook", "Giới thiệu chủ thể và vấn đề ngay trong 2 giây đầu", "Chủ thể nhìn về phía sản phẩm"],
    ["Trải nghiệm", "Thể hiện thao tác sử dụng chính một cách tự nhiên", "Sản phẩm ở vị trí trung tâm"],
    ["Lợi ích", "Cho thấy kết quả và chi tiết nổi bật", "Giữ khung hình ổn định"],
    ["Hero & CTA", "Kết thúc bằng hero shot có cảm xúc", "Sản phẩm sắc nét, nền gọn"],
  ] as const;

  const sceneList: Scene[] = beats.map((beat, index) => {
    const compiled = compileVideoPrompt({
      rawPrompt: `${project.brief}. Cảnh ${index + 1}: ${beat[1]}.`,
      aspectRatio: project.aspectRatio,
      durationSeconds: 8,
      model: project.model,
      style: project.storyBible.visualStyle,
      audio: project.storyBible.audioDirection,
    });
    return {
      id: `scene_${crypto.randomUUID()}`,
      projectId: project.id,
      sceneIndex: index + 1,
      title: beat[0],
      durationSeconds: 8,
      status: index === 0 ? "planned" : "waiting_previous",
      startState: index === 0 ? "Keyframe mở đầu khóa chủ thể và sản phẩm." : beats[index - 1][2],
      action: beat[1],
      endState: beat[2],
      prompt: compiled.optimizedPromptEn,
      negativePrompt: `${compiled.negativePrompt}, ${project.storyBible.mustAvoid.join(", ")}`,
      transition: index === 0 ? "hard_cut" : "match_cut",
      dependsOnSceneId: null,
      startFrameUri: null,
      endFrameUri: null,
      outputVideoUri: null,
      qualityScore: null,
    };
  });
  for (let index = 1; index < sceneList.length; index += 1) {
    sceneList[index].dependsOnSceneId = sceneList[index - 1].id;
  }

  const scenes = await saveOwnedScenes(user.email, project.id, sceneList);
  if (!scenes) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  return NextResponse.json({ scenes }, { status: 201 });
}
