export const MAX_ASSET_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ASSET_MULTIPART_OVERHEAD_BYTES = 256 * 1024;
export const MAX_ASSET_REQUEST_BYTES =
  MAX_ASSET_FILE_BYTES + MAX_ASSET_MULTIPART_OVERHEAD_BYTES;

export const SUPPORTED_ASSET_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type SupportedAssetMimeType = (typeof SUPPORTED_ASSET_MIME_TYPES)[number];
export type AssetExtension = "jpg" | "png" | "webp";

export type AssetFormat = {
  mimeType: SupportedAssetMimeType;
  extension: AssetExtension;
};

export type AssetValidationError =
  | "empty_asset"
  | "asset_too_large"
  | "asset_read_failed"
  | "truncated_asset"
  | "unsupported_asset"
  | "asset_mime_mismatch";

export type AssetValidationResult =
  | { ok: true; format: AssetFormat; sizeBytes: number }
  | { ok: false; error: AssetValidationError };

const JPEG_FORMAT: AssetFormat = { mimeType: "image/jpeg", extension: "jpg" };
const PNG_FORMAT: AssetFormat = { mimeType: "image/png", extension: "png" };
const WEBP_FORMAT: AssetFormat = { mimeType: "image/webp", extension: "webp" };

const ASSET_HEAD_BYTES = 33;
const ASSET_TAIL_BYTES = 12;
const JPEG_SOI = [0xff, 0xd8] as const;
const JPEG_EOI = [0xff, 0xd9] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IEND = [
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
] as const;
const PNG_IHDR_LENGTH = 13;
const PNG_MINIMUM_CONTAINER_BYTES = 45;
const WEBP_MINIMUM_CONTAINER_BYTES = 20;
const WEBP_MINIMUM_CHUNK_BYTES: Record<string, number> = {
  "VP8 ": 10,
  VP8L: 5,
  VP8X: 10,
};

export async function validateAssetFile(
  file: Blob,
  declaredMimeType: string,
): Promise<AssetValidationResult> {
  const sizeError = validateSize(file.size);
  if (sizeError) return sizeError;

  try {
    const [headBuffer, tailBuffer] = await Promise.all([
      file.slice(0, Math.min(file.size, ASSET_HEAD_BYTES)).arrayBuffer(),
      file.slice(Math.max(0, file.size - ASSET_TAIL_BYTES), file.size).arrayBuffer(),
    ]);
    return validateAssetSlices(
      new Uint8Array(headBuffer),
      new Uint8Array(tailBuffer),
      file.size,
      declaredMimeType,
    );
  } catch {
    return { ok: false, error: "asset_read_failed" };
  }
}

export function validateAssetBytes(
  input: ArrayBuffer | ArrayBufferView,
  declaredMimeType: string,
): AssetValidationResult {
  const bytes = toUint8Array(input);
  return validateAssetSlices(
    bytes.subarray(0, Math.min(bytes.byteLength, ASSET_HEAD_BYTES)),
    bytes.subarray(Math.max(0, bytes.byteLength - ASSET_TAIL_BYTES)),
    bytes.byteLength,
    declaredMimeType,
  );
}

export function detectAssetFormat(
  input: ArrayBuffer | ArrayBufferView,
): AssetValidationResult {
  const bytes = toUint8Array(input);
  const sizeError = validateSize(bytes.byteLength);
  if (sizeError) return sizeError;
  return detectAssetFormatFromSlices(
    bytes.subarray(0, Math.min(bytes.byteLength, ASSET_HEAD_BYTES)),
    bytes.subarray(Math.max(0, bytes.byteLength - ASSET_TAIL_BYTES)),
    bytes.byteLength,
  );
}

function validateAssetSlices(
  head: Uint8Array,
  tail: Uint8Array,
  sizeBytes: number,
  declaredMimeType: string,
): AssetValidationResult {
  const sizeError = validateSize(sizeBytes);
  if (sizeError) return sizeError;

  const detected = detectAssetFormatFromSlices(head, tail, sizeBytes);
  if (!detected.ok) return detected;

  if (declaredMimeType.trim().toLowerCase() !== detected.format.mimeType) {
    return { ok: false, error: "asset_mime_mismatch" };
  }
  return detected;
}

function detectAssetFormatFromSlices(
  head: Uint8Array,
  tail: Uint8Array,
  sizeBytes: number,
): AssetValidationResult {
  if (hasPrefix(head, JPEG_SOI)) {
    if (sizeBytes < 4 || !hasSuffix(tail, JPEG_EOI)) {
      return { ok: false, error: "truncated_asset" };
    }
    return { ok: true, format: JPEG_FORMAT, sizeBytes };
  }

  if (hasPrefix(head, PNG_SIGNATURE)) {
    if (
      sizeBytes < PNG_MINIMUM_CONTAINER_BYTES ||
      head.byteLength < ASSET_HEAD_BYTES ||
      readUint32BigEndian(head, 8) !== PNG_IHDR_LENGTH ||
      readAscii(head, 12, 4) !== "IHDR" ||
      !hasSuffix(tail, PNG_IEND)
    ) {
      return { ok: false, error: "truncated_asset" };
    }
    return { ok: true, format: PNG_FORMAT, sizeBytes };
  }

  if (hasAsciiPrefix(head, "RIFF") || hasAsciiAt(head, 8, "WEBP")) {
    if (sizeBytes < WEBP_MINIMUM_CONTAINER_BYTES || head.byteLength < WEBP_MINIMUM_CONTAINER_BYTES) {
      return { ok: false, error: "truncated_asset" };
    }
    if (!hasAsciiPrefix(head, "RIFF") || !hasAsciiAt(head, 8, "WEBP")) {
      return { ok: false, error: "unsupported_asset" };
    }

    const declaredRiffSize = readUint32LittleEndian(head, 4);
    if (declaredRiffSize + 8 !== sizeBytes) {
      return { ok: false, error: "truncated_asset" };
    }

    const chunkType = readAscii(head, 12, 4);
    const minimumChunkBytes = WEBP_MINIMUM_CHUNK_BYTES[chunkType];
    if (minimumChunkBytes === undefined) {
      return { ok: false, error: "unsupported_asset" };
    }

    const chunkSize = readUint32LittleEndian(head, 16);
    const paddedChunkSize = chunkSize + (chunkSize % 2);
    if (
      chunkSize < minimumChunkBytes ||
      (chunkType === "VP8X" && chunkSize !== minimumChunkBytes) ||
      20 + paddedChunkSize > sizeBytes
    ) {
      return { ok: false, error: "truncated_asset" };
    }
    return { ok: true, format: WEBP_FORMAT, sizeBytes };
  }

  return { ok: false, error: "unsupported_asset" };
}

function validateSize(sizeBytes: number): Extract<AssetValidationResult, { ok: false }> | null {
  if (sizeBytes === 0) return { ok: false, error: "empty_asset" };
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ASSET_FILE_BYTES) {
    return { ok: false, error: "asset_too_large" };
  }
  return null;
}

function toUint8Array(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function hasSuffix(bytes: Uint8Array, suffix: readonly number[]): boolean {
  if (bytes.byteLength < suffix.length) return false;
  const offset = bytes.byteLength - suffix.length;
  return suffix.every((value, index) => bytes[offset + index] === value);
}

function hasAsciiPrefix(bytes: Uint8Array, value: string): boolean {
  return hasAsciiAt(bytes, 0, value);
}

function hasAsciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) return "";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}
