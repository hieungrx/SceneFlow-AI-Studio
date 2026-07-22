import type {
  Project,
  SceneContract,
  StructuredVisualState,
} from "./types";
import { assertConcreteStoryBible } from "./story-bible.ts";

export const STORYBOARD_PLANNER_VERSION = "deterministic-storyboard-v2";
export const SCENE_CONTRACT_VERSION = 2;

export type PlannedScene = {
  title: string;
  transition: "hard_cut" | "match_cut" | "crossfade" | "seamless";
  contract: SceneContract;
};

type PlannerOptions = {
  createSceneId?: (sceneIndex: number) => string;
};

type SceneBlueprint = {
  title: string;
  goal: string;
  primaryAction: string;
  subjectMotion: string;
  cameraMotion: string;
  environmentMotion: string;
  backgroundPolicy: SceneContract["backgroundPolicy"];
  endCameraState: string;
  endCompositionState: string;
  transition: PlannedScene["transition"];
};

const SCENE_BLUEPRINTS: readonly SceneBlueprint[] = [
  {
    title: "Thiết lập sự thật sản phẩm",
    goal: "Thiết lập chủ thể, sản phẩm và bối cảnh đúng với brief ngay trong cảnh mở đầu.",
    primaryAction: "Hé lộ chủ thể và sản phẩm trong một hành động giới thiệu có kiểm soát.",
    subjectMotion: "Chủ thể thực hiện một chuyển động nhỏ, tự nhiên để hướng sự chú ý vào sản phẩm.",
    cameraMotion: "slow dolly in",
    environmentMotion: "Chỉ duy trì chuyển động môi trường tự nhiên ở mức tối thiểu.",
    backgroundPolicy: "controlled_motion",
    endCameraState: "Khung trung cận ổn định, sẵn sàng làm điểm nối cho cảnh tiếp theo.",
    endCompositionState: "Chủ thể và sản phẩm cùng rõ ràng, sản phẩm nằm tại vùng ưu tiên của khung hình.",
    transition: "hard_cut",
  },
  {
    title: "Trải nghiệm cốt lõi",
    goal: "Thể hiện một tương tác sản phẩm duy nhất, bám sát ý định trung tâm của brief.",
    primaryAction: "Thực hiện một thao tác sử dụng sản phẩm chính trong brief.",
    subjectMotion: "Chuyển động của chủ thể chỉ phục vụ thao tác sản phẩm chính.",
    cameraMotion: "locked camera",
    environmentMotion: "Giữ bối cảnh ổn định, không có vật thể mới đi vào khung hình.",
    backgroundPolicy: "static",
    endCameraState: "Camera khóa ở khung trung cận sau khi thao tác hoàn tất.",
    endCompositionState: "Sản phẩm ở trung tâm và trạng thái sau thao tác được nhìn thấy rõ.",
    transition: "match_cut",
  },
  {
    title: "Lợi ích nhìn thấy được",
    goal: "Cho thấy một kết quả trực quan của trải nghiệm mà không thay đổi sự thật sản phẩm.",
    primaryAction: "Trình bày một kết quả sản phẩm rõ ràng trong cùng không gian.",
    subjectMotion: "Chủ thể lùi khỏi vùng ưu tiên để kết quả sản phẩm trở thành tiêu điểm.",
    cameraMotion: "slow lateral track",
    environmentMotion: "Chỉ cho phép chuyển động nền nhẹ và liên tục.",
    backgroundPolicy: "controlled_motion",
    endCameraState: "Camera dừng hoàn toàn ở góc làm rõ lợi ích sản phẩm.",
    endCompositionState: "Kết quả sản phẩm chiếm vùng ưu tiên, không có chi tiết cạnh tranh mới.",
    transition: "match_cut",
  },
  {
    title: "Hero shot kết thúc",
    goal: "Kết thúc bằng một hero composition nhất quán với brief và các khóa hình ảnh.",
    primaryAction: "Ổn định sản phẩm trong một hero composition duy nhất.",
    subjectMotion: "Chủ thể giữ tư thế tự nhiên và không thực hiện thêm hành động mới.",
    cameraMotion: "locked camera",
    environmentMotion: "Nền giữ tĩnh trong toàn bộ nhịp kết thúc.",
    backgroundPolicy: "static",
    endCameraState: "Camera khóa hoàn toàn ở hero frame cuối.",
    endCompositionState: "Sản phẩm sắc nét trong hero frame gọn, ổn định và không có vật thể mới.",
    transition: "match_cut",
  },
] as const;

export function planDeterministicStoryboard(
  project: Project,
  options: PlannerOptions = {},
): PlannedScene[] {
  assertConcreteStoryBible(project.storyBible);
  const createSceneId = options.createSceneId ?? (() => `scene_${crypto.randomUUID()}`);
  const continuityLocks = buildContinuityLocks(project);
  const riskFactors = detectRiskFactors(project.brief);
  const initialState = buildInitialState(project);
  const sceneBlueprints = buildProjectBlueprints(project);
  let previousEndState = initialState;

  return sceneBlueprints.map((blueprint, index) => {
    const sceneIndex = index + 1;
    const sceneId = createSceneId(sceneIndex);
    const startState = cloneVisualState(previousEndState);
    const endState: StructuredVisualState = {
      subjectState: project.storyBible.characterLock,
      productState: project.storyBible.productLock,
      environmentState: project.storyBible.environmentLock,
      lightingState: project.storyBible.lightingLock,
      cameraState: blueprint.endCameraState,
      compositionState: blueprint.endCompositionState,
    };
    const contract: SceneContract = {
      version: SCENE_CONTRACT_VERSION,
      sceneId,
      sceneIndex,
      goal: `${blueprint.goal} Ý định dự án: ${project.brief.trim()}`,
      startState,
      endState,
      primaryAction: blueprint.primaryAction,
      subjectMotion: blueprint.subjectMotion,
      cameraMotion: blueprint.cameraMotion,
      environmentMotion: blueprint.environmentMotion,
      backgroundPolicy: blueprint.backgroundPolicy,
      visualStyle: project.storyBible.visualStyle,
      audioDirection: project.storyBible.audioDirection,
      continuityLocks,
      negativeConstraints: [...project.storyBible.mustAvoid],
      generationMode: sceneIndex === 1 ? "text_to_video" : "first_frame",
      riskFactors: sceneRiskFactors(sceneIndex, blueprint, riskFactors),
      stableEndSeconds: 0.75,
    };
    previousEndState = endState;
    return { title: blueprint.title, transition: blueprint.transition, contract };
  });
}

function buildProjectBlueprints(project: Project): SceneBlueprint[] {
  const coreIntent = extractCoreIntent(project.brief);
  const templateContext = project.template.trim() || "video sản phẩm";
  return SCENE_BLUEPRINTS.map((blueprint, index) => ({
    ...blueprint,
    goal: [
      `Thiết lập sự thật hình ảnh cho ${templateContext}: ${coreIntent}.`,
      `Thể hiện trực tiếp hành động cốt lõi của brief: ${coreIntent}.`,
      `Cho thấy một kết quả trực quan bắt nguồn từ: ${coreIntent}.`,
      `Khép lại ${templateContext} bằng hero composition cho: ${coreIntent}.`,
    ][index],
    primaryAction: [
      `Mở đầu khoảnh khắc cốt lõi này trong một hành động: ${coreIntent}.`,
      `Thực hiện đúng hành động cốt lõi này một lần: ${coreIntent}.`,
      `Trình bày một kết quả trực quan trực tiếp của hành động: ${coreIntent}.`,
      `Ổn định sản phẩm sau hành động trong một hero frame cho: ${coreIntent}.`,
    ][index],
  }));
}

function buildInitialState(project: Project): StructuredVisualState {
  return {
    subjectState: project.storyBible.characterLock,
    productState: project.storyBible.productLock,
    environmentState: project.storyBible.environmentLock,
    lightingState: project.storyBible.lightingLock,
    cameraState: `Khung ${project.aspectRatio} ổn định, chủ thể và sản phẩm đều đọc được.`,
    compositionState: "Bố cục mở đầu gọn, không có vật thể ngoài brief.",
  };
}

function buildContinuityLocks(project: Project): string[] {
  return [
    `Nhân vật: ${project.storyBible.characterLock}`,
    `Sản phẩm: ${project.storyBible.productLock}`,
    `Bối cảnh: ${project.storyBible.environmentLock}`,
    `Ánh sáng: ${project.storyBible.lightingLock}`,
    `Phong cách: ${project.storyBible.visualStyle}`,
  ];
}

function detectRiskFactors(brief: string): string[] {
  const normalized = brief.toLocaleLowerCase("vi");
  const risks: string[] = [];
  if (/tay|ngón|cầm|nắm|hand|finger|hold/.test(normalized)) risks.push("hands_or_fingers");
  if (/nước|cà phê|sữa|hơi|liquid|steam|pour/.test(normalized)) risks.push("liquid_or_steam");
  if (/người|nhân vật|koc|mặt|person|face/.test(normalized)) risks.push("human_identity");
  if (/chữ|logo|nhãn|text|label/.test(normalized)) risks.push("text_or_logo_integrity");
  return risks;
}

function extractCoreIntent(brief: string): string {
  const normalized = brief.trim().replace(/\s+/g, " ");
  const firstStep = normalized.split(
    /(?:\b(?:then|and then|followed by|after that)\b|\b(?:sau đó|rồi|tiếp theo)\b|[;!?])/i,
    1,
  )[0]?.replace(/[.]+$/, "").trim();
  if (!firstStep) return "giới thiệu sản phẩm theo Story Bible đã khóa";
  return firstStep.length <= 220 ? firstStep : `${firstStep.slice(0, 217).trimEnd()}...`;
}

function sceneRiskFactors(
  sceneIndex: number,
  blueprint: SceneBlueprint,
  projectRisks: string[],
): string[] {
  const risks = new Set(projectRisks);
  if (sceneIndex > 1) risks.add("approved_previous_frame_continuity");
  if (blueprint.backgroundPolicy === "static") risks.add("background_drift");
  return [...risks];
}

function cloneVisualState(state: StructuredVisualState): StructuredVisualState {
  return { ...state };
}
