import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../chatgpt-auth";
import { putProjectAsset } from "../../../lib/media-store";
import { createOwnedAsset, getOwnedProject } from "../../../lib/repository";
import type { AssetKind } from "../../../lib/types";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_KINDS = new Set<AssetKind>(["product", "character", "environment", "keyframe"]);

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const projectId = form?.get("projectId");
  const kind = form?.get("kind");
  if (
    !(file instanceof File) ||
    typeof projectId !== "string" ||
    typeof kind !== "string" ||
    !ALLOWED_KINDS.has(kind as AssetKind)
  ) {
    return NextResponse.json({ error: "invalid_asset_payload" }, { status: 400 });
  }
  if (!(await getOwnedProject(user.email, projectId))) {
    return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }
  if (!ALLOWED_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "unsupported_asset", message: "Chỉ nhận JPG, PNG, WebP tối đa 20 MB." },
      { status: 415 },
    );
  }

  const id = `asset_${crypto.randomUUID()}`;
  const extension = extensionFor(file.type);
  const r2Key = `projects/${projectId}/references/${id}.${extension}`;
  try {
    await putProjectAsset({
      key: r2Key,
      bytes: await file.arrayBuffer(),
      contentType: file.type,
      ownerId: user.email,
      projectId,
      kind,
      originalName: file.name.slice(0, 160),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "media_storage_unavailable", message: error instanceof Error ? error.message : "R2 unavailable" },
      { status: 503 },
    );
  }

  const asset = await createOwnedAsset(user.email, {
    id,
    projectId,
    kind: kind as AssetKind,
    r2Key,
    filename: file.name.slice(0, 160),
    contentType: file.type,
    sizeBytes: file.size,
  });
  return NextResponse.json({ asset }, { status: 201 });
}

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}
