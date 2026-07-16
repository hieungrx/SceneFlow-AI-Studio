type ClosedByteRange = {
  kind: "closed";
  start: number;
  end: number;
  headerValue: string;
};

type OpenByteRange = {
  kind: "open";
  start: number;
  headerValue: string;
};

type SuffixByteRange = {
  kind: "suffix";
  suffixLength: number;
  headerValue: string;
};

type ParsedByteRange = ClosedByteRange | OpenByteRange | SuffixByteRange;

type ByteRangeParseResult =
  | { ok: true; range: ParsedByteRange | null }
  | { ok: false };

type PrivateVideoResponseOptions = {
  range: ParsedByteRange | null;
  filename: string;
};

type ContentRange = {
  start: number;
  end: number;
  total: number;
};

const MAX_RANGE_HEADER_LENGTH = 128;

export function parseSingleByteRange(value: string | null): ByteRangeParseResult {
  if (value === null) return { ok: true, range: null };
  if (value.length === 0 || value.length > MAX_RANGE_HEADER_LENGTH || value.includes(",")) {
    return { ok: false };
  }

  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return { ok: false };

  if (!match[1]) {
    const suffixLength = parseSafeDecimal(match[2]);
    if (suffixLength === null || suffixLength === 0) return { ok: false };
    return {
      ok: true,
      range: {
        kind: "suffix",
        suffixLength,
        headerValue: `bytes=-${suffixLength}`,
      },
    };
  }

  const start = parseSafeDecimal(match[1]);
  if (start === null) return { ok: false };

  if (!match[2]) {
    return {
      ok: true,
      range: { kind: "open", start, headerValue: `bytes=${start}-` },
    };
  }

  const end = parseSafeDecimal(match[2]);
  if (end === null || end < start) return { ok: false };
  return {
    ok: true,
    range: { kind: "closed", start, end, headerValue: `bytes=${start}-${end}` },
  };
}

export function createInvalidMediaRangeResponse(): Response {
  return jsonErrorResponse("invalid_media_range", 416);
}

export function createMediaUpstreamFailedResponse(): Response {
  return jsonErrorResponse("media_upstream_failed", 502);
}

export async function createPrivateVideoResponse(
  upstream: Response,
  options: PrivateVideoResponseOptions,
): Promise<Response> {
  if (upstream.status === 416) {
    return createRangeNotSatisfiableResponse(upstream, options.range);
  }

  const expectedStatus = options.range ? 206 : 200;
  if (upstream.status !== expectedStatus) return rejectUpstream(upstream);

  const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "video/mp4") return rejectUpstream(upstream);

  const contentLength = parseOptionalContentLength(upstream.headers.get("content-length"));
  if (contentLength === false) return rejectUpstream(upstream);

  const headers = successHeaders(options.filename);
  if (contentLength !== null) headers.set("content-length", String(contentLength));

  const contentRangeValue = upstream.headers.get("content-range");
  if (options.range) {
    const contentRange = parseContentRange(contentRangeValue);
    if (
      !contentRange
      || !rangeResponseMatches(options.range, contentRange)
      || (contentLength !== null && contentLength !== contentRange.end - contentRange.start + 1)
    ) {
      return rejectUpstream(upstream);
    }
    headers.set(
      "content-range",
      `bytes ${contentRange.start}-${contentRange.end}/${contentRange.total}`,
    );
  } else if (contentRangeValue !== null) {
    return rejectUpstream(upstream);
  }

  const etag = upstream.headers.get("etag");
  if (etag) headers.set("etag", etag);
  return new Response(upstream.body, { status: expectedStatus, headers });
}

function parseSafeDecimal(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseOptionalContentLength(value: string | null): number | null | false {
  if (value === null) return null;
  return parseSafeDecimal(value) ?? false;
}

function parseContentRange(value: string | null): ContentRange | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;

  const start = parseSafeDecimal(match[1]);
  const end = parseSafeDecimal(match[2]);
  const total = parseSafeDecimal(match[3]);
  if (start === null || end === null || total === null || start > end || end >= total) {
    return null;
  }
  return { start, end, total };
}

function rangeResponseMatches(range: ParsedByteRange, response: ContentRange): boolean {
  if (range.kind === "closed") {
    return response.start === range.start
      && response.end === Math.min(range.end, response.total - 1);
  }
  if (range.kind === "open") {
    return response.start === range.start && response.end === response.total - 1;
  }

  const expectedLength = Math.min(range.suffixLength, response.total);
  return response.start === response.total - expectedLength
    && response.end === response.total - 1;
}

async function createRangeNotSatisfiableResponse(
  upstream: Response,
  range: ParsedByteRange | null,
): Promise<Response> {
  const total = parseUnsatisfiedContentRange(upstream.headers.get("content-range"));
  if (range === null || total === null || !rangeIsUnsatisfiable(range, total)) {
    return rejectUpstream(upstream);
  }

  await cancelBody(upstream);
  const response = jsonErrorResponse("media_range_not_satisfiable", 416);
  response.headers.set("content-range", `bytes */${total}`);
  return response;
}

function parseUnsatisfiedContentRange(value: string | null): number | null {
  const match = value?.match(/^bytes \*\/(\d+)$/i);
  if (!match) return null;
  return parseSafeDecimal(match[1]);
}

function rangeIsUnsatisfiable(range: ParsedByteRange, total: number): boolean {
  if (total === 0) return true;
  if (range.kind === "suffix") return false;
  return range.start >= total;
}

function successHeaders(filename: string): Headers {
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "video.mp4";
  return new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": `inline; filename="${safeFilename}"`,
    "content-type": "video/mp4",
    "x-content-type-options": "nosniff",
  });
}

function jsonErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function rejectUpstream(upstream: Response): Promise<Response> {
  await cancelBody(upstream);
  return createMediaUpstreamFailedResponse();
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A rejected upstream response must never expose its body, even when cancellation fails.
  }
}
