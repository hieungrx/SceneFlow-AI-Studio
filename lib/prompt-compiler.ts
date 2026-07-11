import type { AspectRatio, PromptCompilation, VideoModel } from "./types";

type CompilePromptInput = {
  rawPrompt: string;
  aspectRatio?: AspectRatio;
  durationSeconds?: 4 | 6 | 8;
  model?: VideoModel;
  style?: string;
  audio?: string;
};

const DEFAULT_STYLE =
  "photorealistic cinematic commercial, natural motion, realistic textures, controlled camera movement";

export function compileVideoPrompt(input: CompilePromptInput): PromptCompilation {
  const rawPrompt = input.rawPrompt.trim();
  const aspectRatio = input.aspectRatio ?? "9:16";
  const durationSeconds = input.durationSeconds ?? 8;
  const model = input.model ?? "veo-3.1-lite";
  const style = input.style?.trim() || DEFAULT_STYLE;
  const audio = input.audio?.trim() || "clean natural ambience matching the scene";

  const assumptions: string[] = [];
  const clarificationQuestions: string[] = [];

  if (rawPrompt.length < 24) {
    clarificationQuestions.push("Chủ thể chính đang làm hành động gì trong cảnh này?");
  }
  if (!/dọc|ngang|9:16|16:9/i.test(rawPrompt)) {
    assumptions.push(`Dùng khung hình ${aspectRatio} theo cấu hình dự án.`);
  }
  if (!/âm thanh|tiếng|voice|thoại|nhạc/i.test(rawPrompt)) {
    assumptions.push("Dùng âm thanh môi trường tự nhiên, không tự thêm lời thoại.");
  }

  const orientation = aspectRatio === "9:16" ? "vertical 9:16" : "landscape 16:9";
  const optimizedPromptEn = [
    `${durationSeconds}-second ${orientation} single-shot video.`,
    `Core user intent: ${rawPrompt || "A polished product-focused visual story"}.`,
    `Visual direction: ${style}.`,
    "Use one primary subject, one clear action, and one controlled camera movement.",
    `Audio: ${audio}.`,
    "Preserve product shape, colors, wardrobe, facial identity, lighting direction, and spatial continuity.",
    "End on a stable composition for at least 0.5 seconds so the next shot can continue smoothly.",
  ].join(" ");

  return {
    intent: rawPrompt || "Tạo video quảng cáo sản phẩm có tính điện ảnh",
    lockedFields: ["chủ thể", "sản phẩm", "trang phục", "tỷ lệ khung hình"],
    assumptions,
    clarificationQuestions,
    optimizedPromptEn,
    negativePrompt:
      "identity drift, product deformation, duplicated objects, distorted hands, unreadable text, logos, flicker, abrupt camera jumps",
    config: { aspectRatio, durationSeconds, model },
  };
}
