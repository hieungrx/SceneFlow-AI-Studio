export type RendererResponse = {
  outputUri?: string;
  output?: {
    contentType?: string;
    bytes?: number;
    durationSeconds?: number;
    width?: number;
    height?: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type RendererHttpOptions = {
  requestId: string;
  expectedOutputUri: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class RendererRequestError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; code: string; retryable: boolean }) {
    super(message);
    this.name = "RendererRequestError";
    this.status = options.status ?? null;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export async function callRendererHttp(
  url: string,
  secret: string,
  path: string,
  payload: unknown,
  options: RendererHttpOptions,
): Promise<RendererResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 540_000;
  let response: Response;

  try {
    response = await fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: {
        "x-renderer-token": secret,
        "x-request-id": options.requestId,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new RendererRequestError(
      timedOut ? "Renderer request timed out." : "Renderer request failed before receiving a response.",
      { code: timedOut ? "renderer_timeout" : "renderer_unreachable", retryable: true },
    );
  }

  const body = (await response.json().catch(() => ({}))) as RendererResponse;
  if (!response.ok) {
    throw new RendererRequestError(
      body.error?.message ?? `Renderer request failed (${response.status}).`,
      {
        status: response.status,
        code: body.error?.code ?? "renderer_request_failed",
        retryable: [429, 502, 503, 504].includes(response.status),
      },
    );
  }
  if (body.outputUri !== options.expectedOutputUri) {
    throw new RendererRequestError("Renderer returned an unexpected output URI.", {
      status: response.status,
      code: "renderer_output_uri_mismatch",
      retryable: false,
    });
  }
  return body;
}
