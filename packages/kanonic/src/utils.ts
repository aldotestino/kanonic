import { Result } from "better-result";
import type { z } from "zod";

import { ApiError, FetchError, ParseError } from "./errors";
import type {
  ApiErrors,
  Auth,
  Endpoint,
  EndpointTree,
  Plugin,
  RequestContext,
  RetryOptions,
} from "./types";

/**
 * Runtime guard: an Endpoint always has a `method` string property.
 * A nested EndpointTree group never does.
 */
export const isEndpoint = (value: Endpoint | EndpointTree): value is Endpoint =>
  typeof (value as Endpoint).method === "string";

export const buildUrl = ({
  baseUrl,
  path,
  query,
  params,
}: {
  baseUrl: string;
  path: `/${string}`;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
}) => {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);

  if (query) {
    const entries = Object.entries(query).filter(
      ([_, v]) => v !== null && v !== undefined
    );

    for (const [k, v] of entries) {
      if (Array.isArray(v)) {
        for (const item of v) {
          url.searchParams.append(k, item.toString());
        }
      } else {
        url.searchParams.append(k, v?.toString() || "");
      }
    }
  }

  if (params) {
    const entries = Object.entries(params).filter(
      ([_, v]) => v !== null && v !== undefined
    );

    for (const [k, v] of entries) {
      url.pathname = url.pathname.replace(`:${k}`, v?.toString() || "");
    }
  }

  return url.toString();
};

export const buildAuthHeader = (auth?: Auth): Record<string, string> => {
  if (!auth) {
    return {};
  }
  if (auth.type === "bearer") {
    return { Authorization: `Bearer ${auth.token}` };
  }
  return {
    Authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}`,
  };
};

export const safeFetch = (url: string, init?: RequestInit) =>
  Result.tryPromise({
    catch: (error) =>
      new FetchError({
        cause: error,
        message:
          error instanceof Error ? error.message : "Something went wrong",
      }),
    try: () => fetch(url, init),
  });

export const safeJsonParse = (text: string) =>
  Result.try({
    catch: (error) =>
      new ParseError({
        cause: error,
        message:
          error instanceof Error ? error.message : "Failed to parse JSON",
      }),
    try: () => JSON.parse(text) as unknown,
  });

export const parseErrorResponse = <E>(
  text: string,
  statusCode: number,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
): ApiError<E> => {
  if (!errorSchema) {
    return new ApiError<E>({ statusCode, text });
  }

  const shouldValidate = shouldValidateError
    ? shouldValidateError(statusCode)
    : false;

  if (!shouldValidate) {
    return new ApiError<E>({ statusCode, text });
  }

  const json = safeJsonParse(text).mapError(
    (_) => new ApiError<E>({ statusCode, text })
  );

  if (json.isErr()) {
    return json.error;
  }

  const result = errorSchema.safeParse(json.value);
  if (result.success) {
    return new ApiError<E>({ data: result.data, statusCode, text });
  }

  return new ApiError<E>({ statusCode, text });
};

export const getRetryDelay = (
  retry: Pick<RetryOptions, "backoff" | "delayMs">,
  attemptIndex: number
) => {
  switch (retry.backoff) {
    case "linear": {
      return retry.delayMs * (attemptIndex + 1);
    }
    case "exponential": {
      return retry.delayMs * 2 ** attemptIndex;
    }
    default: {
      return retry.delayMs;
    }
  }
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isRetriableError = (
  err: ApiErrors<unknown>
): err is FetchError | ApiError<unknown> =>
  err._tag === "FetchError" || err._tag === "ApiError";

export const withRetry = async <E>(
  attempt: () => Promise<Result<unknown, ApiErrors<E>>>,
  retry: RetryOptions<E>
): Promise<Result<unknown, ApiErrors<E>>> => {
  const shouldRetryFn = retry.shouldRetry ?? (() => true);

  let lastResult = await attempt();

  for (let i = 0; i < retry.times; i += 1) {
    if (lastResult.isOk()) {
      break;
    }
    const { error } = lastResult;
    if (!isRetriableError(error)) {
      break;
    }
    if (!shouldRetryFn(error)) {
      break;
    }
    await sleep(getRetryDelay(retry, i));
    lastResult = await attempt();
  }

  return lastResult;
};

export const extractDataLine = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const dataContent = trimmed.slice(5).trim();
  if (!dataContent || dataContent === "[DONE]") {
    return null;
  }
  return dataContent;
};

export const processStreamChunk = (
  dataContent: string,
  outputSchema?: z.ZodType,
  validateOutput = true
): unknown => {
  if (!outputSchema) {
    return dataContent;
  }

  const processedData = safeJsonParse(dataContent).match({
    err: (_) => null,
    ok: (data) => data,
  });

  if (!processedData) {
    return null;
  }

  if (validateOutput) {
    const result = outputSchema.safeParse(processedData);
    if (!result.success) {
      return null;
    }
    return result.data;
  }

  return processedData;
};

// ─── Plugin pipeline runners ─────────────────────────────────────────────────

/**
 * Runs each plugin's `init` function sequentially, threading the url/options
 * through each one. Returns the final (potentially mutated) url and options.
 */
export const runPluginInit = async <E>(
  plugins: Plugin<E>[],
  url: string,
  options: RequestInit
): Promise<{ url: string; options: RequestInit }> => {
  let current = { url, options };
  for (const plugin of plugins) {
    if (plugin.init) {
      current = await plugin.init(current.url, current.options);
    }
  }
  return current;
};

/**
 * Runs each plugin's `onRequest` hook sequentially, threading the
 * `RequestContext` through each one. Returns the final context.
 */
export const runOnRequest = async <E>(
  plugins: Plugin<E>[],
  ctx: RequestContext
): Promise<RequestContext> => {
  let current = ctx;
  for (const plugin of plugins) {
    if (plugin.hooks?.onRequest) {
      current = await plugin.hooks.onRequest(current);
    }
  }
  return current;
};

/**
 * Runs each plugin's `onResponse` hook sequentially, threading the
 * `Response` through each one. Returns the final response.
 */
export const runOnResponse = async <E>(
  plugins: Plugin<E>[],
  ctx: RequestContext,
  response: Response
): Promise<Response> => {
  let current = response;
  for (const plugin of plugins) {
    if (plugin.hooks?.onResponse) {
      current = await plugin.hooks.onResponse(ctx, current);
    }
  }
  return current;
};

/**
 * Calls each plugin's `onSuccess` hook sequentially (fire-and-forget).
 * Errors thrown by individual plugins are silently swallowed so they cannot
 * affect the caller's result.
 */
export const runOnSuccess = async <E>(
  plugins: Plugin<E>[],
  ctx: RequestContext,
  data: unknown
): Promise<void> => {
  for (const plugin of plugins) {
    if (plugin.hooks?.onSuccess) {
      try {
        await plugin.hooks.onSuccess(ctx, data);
      } catch {
        // swallow — fire-and-forget
      }
    }
  }
};

/**
 * Calls each plugin's `onError` hook sequentially (fire-and-forget).
 * Errors thrown by individual plugins are silently swallowed.
 */
export const runOnError = async <E>(
  plugins: Plugin<E>[],
  ctx: RequestContext,
  error: ApiErrors<E>
): Promise<void> => {
  for (const plugin of plugins) {
    if (plugin.hooks?.onError) {
      try {
        await plugin.hooks.onError(ctx, error);
      } catch {
        // swallow — fire-and-forget
      }
    }
  }
};

/**
 * Calls each plugin's `onRetry` hook sequentially (fire-and-forget).
 * Errors thrown by individual plugins are silently swallowed.
 */
export const runOnRetry = async <E>(
  plugins: Plugin<E>[],
  ctx: RequestContext,
  error: FetchError | ApiError<E>
): Promise<void> => {
  for (const plugin of plugins) {
    if (plugin.hooks?.onRetry) {
      try {
        await plugin.hooks.onRetry(ctx, error);
      } catch {
        // swallow — fire-and-forget
      }
    }
  }
};
