import { MAX_ASSET_REQUEST_BYTES } from "./asset-validation.ts";

export type BoundedMultipartError =
  | "invalid_request_limit"
  | "invalid_content_length"
  | "invalid_multipart_request"
  | "request_body_unreadable"
  | "asset_request_too_large";

export type BoundedMultipartResult =
  | { ok: true; formData: FormData; bytesRead: number }
  | { ok: false; error: BoundedMultipartError; status: 400 | 413 | 500 };

export async function parseBoundedMultipartFormData(
  request: Request,
  maxBytes = MAX_ASSET_REQUEST_BYTES,
): Promise<BoundedMultipartResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { ok: false, error: "invalid_request_limit", status: 500 };
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength === false) {
    return { ok: false, error: "invalid_content_length", status: 400 };
  }
  if (contentLength !== null && contentLength > maxBytes) {
    return { ok: false, error: "asset_request_too_large", status: 413 };
  }

  const contentType = request.headers.get("content-type");
  if (!contentType || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, error: "invalid_multipart_request", status: 400 };
  }
  if (!request.body) {
    return { ok: false, error: "invalid_multipart_request", status: 400 };
  }

  const boundedBody = createBoundedBodyStream(request.body, maxBytes);

  try {
    const formData = await new Response(boundedBody.stream, {
      headers: { "content-type": contentType },
    }).formData();
    return { ok: true, formData, bytesRead: boundedBody.bytesRead() };
  } catch {
    const streamError = boundedBody.error();
    if (streamError) return streamError;
    return { ok: false, error: "invalid_multipart_request", status: 400 };
  }
}

type BoundedBodyStream = {
  stream: ReadableStream<Uint8Array>;
  bytesRead: () => number;
  error: () => Extract<BoundedMultipartResult, { ok: false }> | null;
};

function createBoundedBodyStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): BoundedBodyStream {
  const reader = source.getReader();
  let totalBytes = 0;
  let streamError: Extract<BoundedMultipartResult, { ok: false }> | null = null;
  let released = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          releaseReader();
          controller.close();
          return;
        }

        totalBytes += result.value.byteLength;
        if (totalBytes > maxBytes) {
          streamError = { ok: false, error: "asset_request_too_large", status: 413 };
          controller.error(new Error("bounded_multipart_stream_failed"));
          await cancelReader(reader);
          releaseReader();
          return;
        }
        controller.enqueue(result.value);
      } catch {
        streamError = { ok: false, error: "request_body_unreadable", status: 400 };
        controller.error(new Error("bounded_multipart_stream_failed"));
        await cancelReader(reader);
        releaseReader();
      }
    },
    async cancel() {
      await cancelReader(reader);
      releaseReader();
    },
  });

  return {
    stream,
    bytesRead: () => totalBytes,
    error: () => streamError,
  };

  function releaseReader(): void {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // The stream is already terminal; there is no lock left to release.
    }
  }
}

function parseContentLength(value: string | null): number | null | false {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : false;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The caller receives a stable local error even when body cancellation fails.
  }
}
