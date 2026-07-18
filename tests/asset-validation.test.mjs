import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ASSET_FILE_BYTES,
  MAX_ASSET_REQUEST_BYTES,
  detectAssetFormat,
  validateAssetBytes,
  validateAssetFile,
} from "../lib/asset-validation.ts";

test("exports a 20 MB file limit and a larger bounded multipart limit", () => {
  assert.equal(MAX_ASSET_FILE_BYTES, 20 * 1024 * 1024);
  assert.ok(MAX_ASSET_REQUEST_BYTES > MAX_ASSET_FILE_BYTES);
});

test("detects JPEG and treats its bytes as the authoritative format", () => {
  const bytes = plausibleJpegContainer();
  assert.deepEqual(validateAssetBytes(bytes, "IMAGE/JPEG"), {
    ok: true,
    format: { mimeType: "image/jpeg", extension: "jpg" },
    sizeBytes: bytes.byteLength,
  });
  assert.deepEqual(validateAssetBytes(bytes, "image/png"), {
    ok: false,
    error: "asset_mime_mismatch",
  });
});

test("detects a PNG only when its signature, IHDR and canonical IEND are present", () => {
  const bytes = plausiblePngContainer();
  assert.deepEqual(validateAssetBytes(bytes.buffer, "image/png"), {
    ok: true,
    format: { mimeType: "image/png", extension: "png" },
    sizeBytes: bytes.byteLength,
  });

  assert.deepEqual(detectAssetFormat(bytes.subarray(0, 20)), {
    ok: false,
    error: "truncated_asset",
  });
  const invalidIhdr = bytes.slice();
  invalidIhdr[15] = "X".charCodeAt(0);
  assert.deepEqual(detectAssetFormat(invalidIhdr), {
    ok: false,
    error: "truncated_asset",
  });

  const invalidIend = bytes.slice();
  invalidIend[invalidIend.byteLength - 1] ^= 0xff;
  assert.deepEqual(detectAssetFormat(invalidIend), {
    ok: false,
    error: "truncated_asset",
  });
});

test("detects WebP and validates RIFF size, chunk type and chunk bounds", () => {
  const bytes = validWebp("VP8L", Uint8Array.from([0x2f, 0x00, 0x00, 0x00, 0x00]));
  assert.deepEqual(validateAssetBytes(bytes, "image/webp"), {
    ok: true,
    format: { mimeType: "image/webp", extension: "webp" },
    sizeBytes: bytes.byteLength,
  });

  const wrongRiffSize = bytes.slice();
  wrongRiffSize[4] = 0;
  assert.deepEqual(detectAssetFormat(wrongRiffSize), {
    ok: false,
    error: "truncated_asset",
  });

  const truncatedChunk = bytes.slice();
  writeUint32LittleEndian(truncatedChunk, 16, 200);
  assert.deepEqual(detectAssetFormat(truncatedChunk), {
    ok: false,
    error: "truncated_asset",
  });

  const unsupportedChunk = bytes.slice();
  writeAscii(unsupportedChunk, 12, "JUNK");
  assert.deepEqual(detectAssetFormat(unsupportedChunk), {
    ok: false,
    error: "unsupported_asset",
  });
});

test("rejects empty, unknown, truncated JPEG and oversized inputs", () => {
  assert.deepEqual(detectAssetFormat(new Uint8Array()), {
    ok: false,
    error: "empty_asset",
  });
  assert.deepEqual(detectAssetFormat(Uint8Array.from([1, 2, 3, 4])), {
    ok: false,
    error: "unsupported_asset",
  });
  assert.deepEqual(detectAssetFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), {
    ok: false,
    error: "truncated_asset",
  });
  assert.deepEqual(detectAssetFormat(new Uint8Array(MAX_ASSET_FILE_BYTES + 1)), {
    ok: false,
    error: "asset_too_large",
  });
});

test("validateAssetFile reads only bounded head and tail slices", async () => {
  const bytes = plausiblePngContainer();
  const slices = [];
  class TrackingBlob extends Blob {
    slice(start, end, contentType) {
      slices.push({ start, end });
      return super.slice(start, end, contentType);
    }
  }
  const file = new TrackingBlob([bytes], { type: "image/png" });

  assert.deepEqual(await validateAssetFile(file, file.type), {
    ok: true,
    format: { mimeType: "image/png", extension: "png" },
    sizeBytes: bytes.byteLength,
  });
  assert.deepEqual(slices, [
    { start: 0, end: 33 },
    { start: bytes.byteLength - 12, end: bytes.byteLength },
  ]);
  assert.equal(slices.reduce((total, item) => total + item.end - item.start, 0), 45);
});

test("validateAssetFile fails safely when a bounded slice cannot be read", async () => {
  class UnreadableBlob extends Blob {
    slice() {
      return {
        async arrayBuffer() {
          throw new Error("private storage detail");
        },
      };
    }
  }

  const file = new UnreadableBlob([plausibleJpegContainer()], { type: "image/jpeg" });
  assert.deepEqual(await validateAssetFile(file, file.type), {
    ok: false,
    error: "asset_read_failed",
  });
});

function plausibleJpegContainer() {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x02,
    0xff, 0xd9,
  ]);
}

function plausiblePngContainer() {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  writeAscii(bytes, 12, "IHDR");
  bytes.set([0x00, 0x00, 0x00, 0x01], 16);
  bytes.set([0x00, 0x00, 0x00, 0x01], 20);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ], 33);
  return bytes;
}

function validWebp(chunkType, payload) {
  const padding = payload.byteLength % 2;
  const bytes = new Uint8Array(20 + payload.byteLength + padding);
  writeAscii(bytes, 0, "RIFF");
  writeUint32LittleEndian(bytes, 4, bytes.byteLength - 8);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, chunkType);
  writeUint32LittleEndian(bytes, 16, payload.byteLength);
  bytes.set(payload, 20);
  return bytes;
}

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function writeUint32LittleEndian(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
