import assert from "node:assert/strict";
import test from "node:test";

import {
  parseConcreteStoryBible,
  validateConcreteStoryBible,
} from "../lib/story-bible.ts";

const concreteStoryBible = {
  characterLock: "Vietnamese barista, black bob hair, beige linen shirt, dark brown apron.",
  productLock: "White 180 ml cup with a cobalt rim, no text, no logo.",
  environmentLock: "Small coffee shop with walnut counter and copper espresso machine.",
  lightingLock: "Warm 7 AM light always enters from camera left.",
  visualStyle: "Photorealistic warm cinematic commercial with shallow depth of field.",
  audioDirection: "Natural coffee shop room tone without dialogue.",
  mustAvoid: ["identity drift", "cup deformation", "extra hands"],
};

test("accepts and normalizes a concrete Story Bible", () => {
  const result = parseConcreteStoryBible({
    ...concreteStoryBible,
    characterLock: `  ${concreteStoryBible.characterLock}  `,
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.storyBible, concreteStoryBible);
});

test("rejects generic locks and unbound reference claims", () => {
  const result = parseConcreteStoryBible({
    ...concreteStoryBible,
    characterLock: "Giữ nguyên khuôn mặt và trang phục từ ảnh tham chiếu.",
    productLock: "Giữ đúng thiết kế, màu sắc và tỷ lệ sản phẩm.",
  });
  assert.equal(result.storyBible, null);
  assert.ok(result.issues.some((issue) =>
    issue.field === "characterLock" && issue.code === "unbound_reference"
  ));
  assert.ok(result.issues.some((issue) =>
    issue.field === "productLock" && issue.code === "generic_placeholder"
  ));
});

test("requires style, audio and mustAvoid before planning", () => {
  const issues = validateConcreteStoryBible({
    ...concreteStoryBible,
    visualStyle: "",
    audioDirection: "",
    mustAvoid: [],
  });
  assert.ok(issues.some((issue) => issue.field === "visualStyle"));
  assert.ok(issues.some((issue) => issue.field === "audioDirection"));
  assert.ok(issues.some((issue) => issue.field === "mustAvoid"));
});
