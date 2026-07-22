import type {
  StoryBible,
  StoryBibleField,
  StoryBibleValidationIssue,
} from "./types";

const TEXT_FIELDS = [
  "characterLock",
  "productLock",
  "environmentLock",
  "lightingLock",
  "visualStyle",
  "audioDirection",
] as const satisfies readonly StoryBibleField[];

const MAX_FIELD_LENGTH = 1_000;
const MAX_MUST_AVOID_ITEMS = 20;
const MAX_MUST_AVOID_LENGTH = 160;
const GENERIC_MARKER_PATTERN = /(?:chưa khóa|không xác định|\btbd\b|\bgeneric\b|mặc định|legacy project has no concrete)/i;
const UNBOUND_REFERENCE_PATTERN = /(?:ảnh\s+(?:tham chiếu|tải lên)|từ\s+ảnh|reference\s+(?:image|asset|input)|uploaded\s+image|bound\s+reference)/i;
const KNOWN_GENERIC_LOCK_PATTERNS = [
  /^giữ đúng thiết kế,? màu sắc.*(?:sản phẩm)?\.?$/i,
  /^dùng cùng một (?:không gian|bối cảnh) trong các cảnh.*\.?$/i,
  /^giữ nguyên hướng sáng.*(?:các cảnh|thời điểm trong ngày).*\.?$/i,
  /^photorealistic cinematic commercial,? natural motion,? realistic textures\.?$/i,
  /^một nền âm thanh xuyên suốt.*(?:người dùng yêu cầu).*\.?$/i,
] as const;

export const LEGACY_UNSET_STORY_BIBLE: StoryBible = {
  characterLock: "Legacy project has no concrete character description.",
  productLock: "Legacy project has no concrete product description.",
  environmentLock: "Legacy project has no concrete environment description.",
  lightingLock: "Legacy project has no concrete lighting description.",
  visualStyle: "Legacy project has no concrete visual style.",
  audioDirection: "Legacy project has no concrete audio direction.",
  mustAvoid: ["legacy product truth is incomplete"],
};

export class StoryBibleValidationError extends Error {
  readonly issues: StoryBibleValidationIssue[];

  constructor(issues: StoryBibleValidationIssue[]) {
    super("Story Bible must contain concrete project truth before storyboard planning.");
    this.name = "StoryBibleValidationError";
    this.issues = issues;
  }
}

export function parseConcreteStoryBible(value: unknown): {
  storyBible: StoryBible | null;
  issues: StoryBibleValidationIssue[];
} {
  const candidate = isRecord(value) ? value : {};
  const storyBible: StoryBible = {
    characterLock: textValue(candidate.characterLock),
    productLock: textValue(candidate.productLock),
    environmentLock: textValue(candidate.environmentLock),
    lightingLock: textValue(candidate.lightingLock),
    visualStyle: textValue(candidate.visualStyle),
    audioDirection: textValue(candidate.audioDirection),
    mustAvoid: Array.isArray(candidate.mustAvoid)
      ? candidate.mustAvoid.map(textValue).filter(Boolean)
      : [],
  };
  const issues = validateConcreteStoryBible(storyBible, candidate.mustAvoid);
  return { storyBible: issues.length === 0 ? storyBible : null, issues };
}

export function validateConcreteStoryBible(
  storyBible: StoryBible,
  rawMustAvoid: unknown = storyBible.mustAvoid,
): StoryBibleValidationIssue[] {
  const issues: StoryBibleValidationIssue[] = [];
  for (const field of TEXT_FIELDS) {
    const value = storyBible[field].trim();
    if (!value) {
      issues.push(issue(field, "missing", `Story Bible field ${field} is required.`));
      continue;
    }
    if (value.length > MAX_FIELD_LENGTH) {
      issues.push(issue(field, "too_long", `Story Bible field ${field} exceeds ${MAX_FIELD_LENGTH} characters.`));
    }
    if (UNBOUND_REFERENCE_PATTERN.test(value)) {
      issues.push(issue(
        field,
        "unbound_reference",
        `${field} cannot claim reference input before reference binding exists.`,
      ));
    }
    if (
      value.length < 16 ||
      GENERIC_MARKER_PATTERN.test(value) ||
      KNOWN_GENERIC_LOCK_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      issues.push(issue(
        field,
        "generic_placeholder",
        `${field} must describe concrete project truth instead of a generic lock.`,
      ));
    }
  }

  if (!Array.isArray(rawMustAvoid) || storyBible.mustAvoid.length === 0) {
    issues.push(issue("mustAvoid", "invalid_list", "mustAvoid must contain at least one concrete constraint."));
  } else if (storyBible.mustAvoid.length > MAX_MUST_AVOID_ITEMS) {
    issues.push(issue(
      "mustAvoid",
      "invalid_list",
      `mustAvoid cannot contain more than ${MAX_MUST_AVOID_ITEMS} constraints.`,
    ));
  }
  if (storyBible.mustAvoid.some((value) => value.length < 3 || value.length > MAX_MUST_AVOID_LENGTH)) {
    issues.push(issue(
      "mustAvoid",
      "invalid_list",
      `Each mustAvoid constraint must be 3-${MAX_MUST_AVOID_LENGTH} characters.`,
    ));
  }
  return issues;
}

export function assertConcreteStoryBible(storyBible: StoryBible): void {
  const issues = validateConcreteStoryBible(storyBible);
  if (issues.length > 0) throw new StoryBibleValidationError(issues);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(
  field: StoryBibleField,
  code: StoryBibleValidationIssue["code"],
  message: string,
): StoryBibleValidationIssue {
  return { field, code, message };
}
