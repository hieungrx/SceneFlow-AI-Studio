import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../chatgpt-auth";
import {
  MAX_ASSET_FILE_BYTES,
  validateAssetFile,
} from "../../../lib/asset-validation";
import { parseBoundedMultipartFormData } from "../../../lib/bounded-multipart-request";
import { deleteProjectAsset, putProjectAsset } from "../../../lib/media-store";
import { createOwnedAsset, getOwnedProject } from "../../../lib/repository";
import type { AssetKind } from "../../../lib/types";

const ALLOWED_KINDS = new Set<AssetKind>(["product", "character", "environment", "keyframe"]);

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const parsedForm = await parseBoundedMultipartFormData(request);
  if (!parsedForm.ok) {
    const error = parsedForm.status === 413
      ? "asset_request_too_large"
      : parsedForm.status === 500
        ? "asset_ingestion_unavailable"
        : "invalid_asset_payload";
    return NextResponse.json({ error }, { status: parsedForm.status });
  }

  const file = parsedForm.formData.get("file");
  const projectId = parsedForm.formData.get("projectId");
  const kind = parsedForm.formData.get("kind");
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
  if (file.size > MAX_ASSET_FILE_BYTES) {
    return NextResponse.json({ error: "asset_request_too_large" }, { status: 413 });
  }

  const validation = await validateAssetFile(file, file.type);
  if (!validation.ok) {
    if (validation.error === "asset_read_failed") {
      return NextResponse.json({ error: "invalid_asset_payload" }, { status: 400 });
    }
    const status = validation.error === "asset_too_large" ? 413 : 415;
    const error = status === 413 ? "asset_request_too_large" : "unsupported_asset";
    return NextResponse.json({ error }, { status });
  }

  const id = `asset_${crypto.randomUUID()}`;
  const r2Key = `projects/${projectId}/references/${id}.${validation.format.extension}`;
  try {
    await putProjectAsset({
      key: r2Key,
      body: file,
      contentType: validation.format.mimeType,
      ownerId: user.email,
      projectId,
      kind,
      originalName: file.name.slice(0, 160),
    });
  } catch {
    return NextResponse.json({ error: "media_storage_unavailable" }, { status: 503 });
  }

  let asset: Awaited<ReturnType<typeof createOwnedAsset>>;
  try {
    asset = await createOwnedAsset(user.email, {
      id,
      projectId,
      kind: kind as AssetKind,
      r2Key,
      filename: file.name.slice(0, 160),
      contentType: validation.format.mimeType,
      sizeBytes: validation.sizeBytes,
    });
  } catch {
    await compensateFailedAssetMetadata(r2Key, id, projectId);
    return NextResponse.json({ error: "asset_metadata_unavailable" }, { status: 503 });
  }
  if (!asset) {
    await compensateFailedAssetMetadata(r2Key, id, projectId);
    return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }
  return NextResponse.json({ asset }, { status: 201 });
}

async function compensateFailedAssetMetadata(
  r2Key: string,
  assetId: string,
  projectId: string,
): Promise<void> {
  try {
    await deleteProjectAsset(r2Key);
  } catch (error) {
    console.error("asset_compensating_delete_failed", {
      assetId,
      projectId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
