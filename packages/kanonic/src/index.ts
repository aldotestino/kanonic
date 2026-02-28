import { Result } from "better-result";
import { z } from "zod";

import {
  ApiError,
  FetchError,
  InputValidationError,
  OutputValidationError,
  ParseError,
} from "./errors";

export type {
  ApiError,
  FetchError,
  InputValidationError,
  OutputValidationError,
  ParseError
};

/**
 * Preset validation function that validates only client errors (4xx status codes).
 *
 * @example
 * ```ts
 * const api = createApi({
 *   baseUrl: "https://api.example.com",
 *   endpoints,
 *   errorSchema: apiErrorSchema,
 *   shouldValidateError: validateClientErrors
 * });
 * ```
 */
export const validateClientErrors = (statusCode: number) =>
  statusCode >= 400 && statusCode < 500;

/**
 * Preset validation function that validates all error responses (both 4xx and 5xx).
 *
 * @example
 * ```ts
 * const api = createApi({
 *   baseUrl: "https://api.example.com",
 *   endpoints,
 *   errorSchema: apiErrorSchema,
 *   shouldValidateError: validateAllErrors
 * });
 * ```
 */
export const validateAllErrors = () => true;

/**
 * Retry configuration for a per-call request. Mirrors better-result's retry
 * API but scoped to kanonic's error types.
 *
 * `shouldRetry` receives either a `FetchError` (network failure) or an
 * `ApiError<E>` (server error response). Validation errors
 * (`InputValidationError`, `OutputValidationError`, `ParseError`) are never
 * retried regardless of this predicate.
 *
 * Delay math (delayMs = d, attempt is 0-indexed):
 *   constant:    d
 *   linear:      d * (attempt + 1)
 *   exponential: d * 2^attempt
 *
 * @example
 * ```ts
 * await api.getUser({ params: { id: 1 } }, {
 *   retry: {
 *     times: 3,
 *     delayMs: 100,
 *     backoff: "exponential",
 *     shouldRetry: (error) => {
 *       if (error._tag === "ApiError") return error.statusCode >= 500;
 *       return true; // always retry network errors
 *     },
 *   },
 * });
 * ```
 */
export type RetryOptions<E = unknown> = {
  /** Number of retries (not counting the initial attempt). Total calls = times + 1. */
  times: number;
  /** Base delay in milliseconds between retries. */
  delayMs: number;
  backoff: "linear" | "constant" | "exponential";
  /**
   * Optional predicate. Return `true` to retry, `false` to stop.
   * Receives only retriable errors: `FetchError` or `ApiError<E>`.
   * Defaults to always retry.
   */
  shouldRetry?: (error: FetchError | ApiError<E>) => boolean;
};

/**
 * A subset of RequestInit that can be supplied at the global, endpoint, or
 * per-call level. `body` and `method` are always controlled by kanonic and
 * therefore excluded.
 *
 * Headers from all three levels are merged, with per-call winning over
 * endpoint-level winning over global. `Content-Type: application/json` is
 * always applied last and cannot be overridden.
 *
 * `retry` is only meaningful at the per-call level; it is ignored on global
 * and endpoint-level `requestOptions`.
 */
export type RequestOptions<E = unknown> = Omit<RequestInit, "body" | "method"> & {
  retry?: RetryOptions<E>;
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Base endpoint properties shared by all methods
interface BaseEndpoint {
  path: `/${string}`;
  query?: z.ZodType;
  params?: z.ZodType;
  output?: z.ZodType;
  stream?: { enabled: boolean };
  /** Fetch options applied to every call of this endpoint (retry is ignored here). */
  requestOptions?: Omit<RequestOptions, "retry">;
}

// GET endpoint (no input body)
type GetEndpoint = BaseEndpoint & {
  method: "GET";
};

// Non-GET endpoint (can have input body)
type NonGetEndpoint = BaseEndpoint & {
  method: Exclude<Method, "GET">;
  input?: z.ZodType;
};

type Endpoint = GetEndpoint | NonGetEndpoint;

// All possible API errors
export type ApiErrors<E = unknown> =
  | FetchError
  | ApiError<E>
  | ParseError
  | OutputValidationError
  | InputValidationError;

// Build the options object type for an endpoint
type EndpointOptions<E extends Endpoint> = (E extends NonGetEndpoint
  ? E["input"] extends z.ZodType
  ? { input: z.infer<E["input"]> }
  : {}
  : {}) &
  (E["params"] extends z.ZodType ? { params: z.infer<E["params"]> } : {}) &
  (E["query"] extends z.ZodType ? { query: z.infer<E["query"]> } : {});

// Determine the success return type based on output schema
type EndpointOutput<E extends Endpoint> = E["output"] extends z.ZodType
  ? z.infer<E["output"]>
  : unknown;

// Check if streaming is enabled
type IsStreamEnabled<E extends Endpoint> = E["stream"] extends { enabled: true }
  ? true
  : false;

// Determine stream element type based on output schema
type StreamElementType<E extends Endpoint> = E["output"] extends z.ZodType
  ? z.infer<E["output"]>
  : string;

// Return type: ReadableStream<T> when streaming, otherwise the output type
type EndpointReturn<E extends Endpoint> =
  IsStreamEnabled<E> extends true
  ? ReadableStream<StreamElementType<E>>
  : EndpointOutput<E>;

type ResultPromise<E extends Endpoint, ErrType> = Promise<
  Result<EndpointReturn<E>, ApiErrors<ErrType>>
>;

/**
 * Function signature for an endpoint with no schema options (no input/params/query).
 * The single optional argument is per-call RequestOptions.
 *
 *   api.listUsers()
 *   api.listUsers({ signal: controller.signal })
 */
type ZeroOptionEndpointFunction<E extends Endpoint, ErrType> = (
  requestOptions?: RequestOptions<ErrType>
) => ResultPromise<E, ErrType>;

/**
 * Function signature for an endpoint that requires schema options.
 * The second optional argument is per-call RequestOptions.
 *
 *   api.getUser({ params: { id: 1 } })
 *   api.getUser({ params: { id: 1 } }, { signal: controller.signal })
 */
type OptionEndpointFunction<E extends Endpoint, ErrType> = (
  options: EndpointOptions<E>,
  requestOptions?: RequestOptions<ErrType>
) => ResultPromise<E, ErrType>;

// The overload: zero-option endpoints take (requestOptions?) while
// endpoints with options take (options, requestOptions?)
export type EndpointFunction<
  E extends Endpoint,
  ErrType = unknown,
> = keyof EndpointOptions<E> extends never
  ? ZeroOptionEndpointFunction<E, ErrType>
  : OptionEndpointFunction<E, ErrType>;

// The final API client type
export type ApiClient<T extends Record<string, Endpoint>, E = unknown> = {
  [K in keyof T]: EndpointFunction<T[K], E>;
};

type Auth =
  | {
    type: "bearer";
    token: string;
  }
  | {
    type: "basic";
    username: string;
    password: string;
  };

const buildUrl = ({
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
    Object.entries(query)
      .filter(([_, v]) => v !== null && v !== undefined)
      .forEach(([k, v]) => {
        if (Array.isArray(v)) {
          v.forEach((item) => url.searchParams.append(k, item.toString()));
        } else {
          url.searchParams.append(k, v?.toString() || "");
        }
      });
  }

  if (params) {
    Object.entries(params)
      .filter(([_, v]) => v !== null && v !== undefined)
      .forEach(([k, v]) => {
        url.pathname = url.pathname.replace(`:${k}`, v?.toString() || "");
      });
  }

  return url.toString();
};

/** Resolve HeadersInit to a plain Record<string, string>. */
const resolveHeaders = (headers?: RequestInit["headers"]): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers as Record<string, string>;
};

const buildAuthHeader = (auth?: Auth): Record<string, string> => {
  if (!auth) return {};
  if (auth.type === "bearer") {
    return { Authorization: `Bearer ${auth.token}` };
  }
  return { Authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` };
};

/**
 * Merge all header sources into a single plain object.
 * Priority (lowest → highest):
 *   auth → global headers → endpoint headers → call headers → Content-Type
 */
const mergeHeaders = (
  auth: Record<string, string>,
  global: Record<string, string>,
  endpoint: Record<string, string>,
  call: Record<string, string>,
): Record<string, string> => ({
  ...auth,
  ...global,
  ...endpoint,
  ...call,
  "Content-Type": "application/json",
});

const safeFetch = (url: string, init?: RequestInit) =>
  Result.tryPromise({
    try: () => fetch(url, init),
    catch: (error) =>
      new FetchError({
        cause: error,
        message:
          error instanceof Error ? error.message : "Something went wrong",
      }),
  });

const safeJsonParse = (text: string) =>
  Result.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) =>
      new ParseError({
        cause: error,
        message:
          error instanceof Error ? error.message : "Failed to parse JSON",
      }),
  });

const parseErrorResponse = <E>(
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

const getRetryDelay = (retry: Pick<RetryOptions, "backoff" | "delayMs">, attemptIndex: number): number => {
  switch (retry.backoff) {
    case "constant": return retry.delayMs;
    case "linear": return retry.delayMs * (attemptIndex + 1);
    case "exponential": return retry.delayMs * (2 ** attemptIndex);
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRetriableError = (
  err: ApiErrors<unknown>
): err is FetchError | ApiError<unknown> =>
  err._tag === "FetchError" || err._tag === "ApiError";

const withRetry = async <E>(
  attempt: () => Promise<Result<unknown, ApiErrors<E>>>,
  retry: RetryOptions<E>
): Promise<Result<unknown, ApiErrors<E>>> => {
  const shouldRetryFn = retry.shouldRetry ?? (() => true);

  let lastResult = await attempt();

  for (let i = 0; i < retry.times; i++) {
    if (lastResult.isOk()) break;
    const error = lastResult.error;
    if (!isRetriableError(error)) break;
    if (!shouldRetryFn(error)) break;
    await sleep(getRetryDelay(retry, i));
    lastResult = await attempt();
  }

  return lastResult;
};

const makeRequest = ({
  method,
  url,
  headers,
  input,
  requestOptions,
}: {
  method: Method;
  url: string;
  headers: Record<string, string>;
  input?: unknown;
  requestOptions?: Omit<RequestOptions, "headers" | "retry">;
}) =>
  safeFetch(url, {
    ...requestOptions,
    body: method === "GET" ? undefined : JSON.stringify(input),
    headers,
    method,
  });

const handleJsonResponse = <E>(
  response: Response,
  outputSchema: z.ZodType,
  validateOutput: boolean,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
) =>
  Result.gen(async function* handleJsonResponse() {
    const text = yield* Result.await(
      Result.tryPromise({
        try: () => response.text(),
        catch: (error) =>
          new ParseError({
            cause: error,
            message:
              error instanceof Error ? error.message : "Something went wrong",
          }),
      })
    );

    if (!response.ok) {
      return Result.err(
        parseErrorResponse(text, response.status, errorSchema, shouldValidateError)
      );
    }

    const json = yield* safeJsonParse(text);

    if (!validateOutput) {
      return Result.ok(json);
    }

    const { success, data, error } = outputSchema.safeParse(json);

    if (!success) {
      return Result.err(
        new OutputValidationError({
          message: "The output from the api was invalid",
          zodError: error,
        })
      );
    }

    return Result.ok(data);
  });

const handleStreamResponse = <E>(
  response: Response,
  outputSchema?: z.ZodType,
  validateOutput = true,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
) =>
  Result.gen(async function* handleStreamResponse() {
    if (!response.ok) {
      const text = yield* Result.await(
        Result.tryPromise({
          try: () => response.text(),
          catch: (error) =>
            new ParseError({
              cause: error,
              message:
                error instanceof Error ? error.message : "Something went wrong",
            }),
        })
      );
      return Result.err(
        parseErrorResponse(text, response.status, errorSchema, shouldValidateError)
      );
    }

    if (!response.body) {
      return Result.err(new ParseError({ message: "Response body is null" }));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const stream = new ReadableStream<unknown>({
      cancel() {
        reader.cancel();
      },
      async pull(controller) {
        const { done, value } = await reader.read();

        if (done) {
          if (buffer.trim()) {
            const lines = buffer.split("\n");
            for (const line of lines) {
              const dataContent = extractDataLine(line);
              if (dataContent !== null) {
                const processedData = processStreamChunk(dataContent, outputSchema, validateOutput);
                if (processedData !== null) {
                  controller.enqueue(processedData);
                }
              }
            }
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const dataContent = extractDataLine(line);
          if (dataContent !== null) {
            const processedData = processStreamChunk(dataContent, outputSchema, validateOutput);
            if (processedData !== null) {
              controller.enqueue(processedData);
            }
          }
        }
      },
    });

    return Result.ok(stream);
  });

const extractDataLine = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const dataContent = trimmed.slice(5).trim();
  if (!dataContent || dataContent === "[DONE]") return null;
  return dataContent;
};

const processStreamChunk = (
  dataContent: string,
  outputSchema?: z.ZodType,
  validateOutput = true
): unknown => {
  if (!outputSchema) return dataContent;

  const processedData = safeJsonParse(dataContent).match({
    ok: (data) => data,
    err: (_) => {
      console.warn("Failed to parse JSON chunk");
      return null;
    },
  });

  if (!processedData) return null;

  if (validateOutput) {
    const result = outputSchema.safeParse(processedData);
    if (!result.success) {
      console.warn("Validation failed for chunk:", result.error);
      return null;
    }
    return result.data;
  }

  return processedData;
};

/**
 * Creates a type-safe API client from endpoint definitions.
 *
 * @example
 * ```ts
 * const api = createApi({
 *   baseUrl: "https://api.example.com",
 *   endpoints,
 *   auth: { type: "bearer", token: "..." },
 *   requestOptions: { credentials: "include" },
 *   errorSchema,
 *   shouldValidateError: validateClientErrors,
 * });
 *
 * // Per-call options (second argument on endpoints with schema options)
 * const ac = new AbortController();
 * const result = await api.getUser({ params: { id: 1 } }, { signal: ac.signal });
 *
 * // Zero-option endpoints take requestOptions as first argument
 * const result = await api.listUsers({ signal: ac.signal });
 * ```
 */
export const createApi = <T extends Record<string, Endpoint>, E = unknown>({
  baseUrl,
  endpoints,
  auth,
  requestOptions: globalRequestOptions,
  validateOutput = true,
  validateInput = true,
  errorSchema,
  shouldValidateError,
}: {
  baseUrl: string;
  endpoints: T;
  auth?: Auth;
  /** Fetch options applied to every request. Headers here are lowest priority. Retry is ignored here. */
  requestOptions?: Omit<RequestOptions, "retry">;
  validateOutput?: boolean;
  validateInput?: boolean;
  errorSchema?: z.ZodType<E>;
  shouldValidateError?: (statusCode: number) => boolean;
}): ApiClient<T, E> => {
  const authHeader = buildAuthHeader(auth);
  const globalHeaders = resolveHeaders(globalRequestOptions?.headers);
  const { headers: _gh, ...globalRestOptions } = globalRequestOptions ?? {};

  const client = {} as ApiClient<T, E>;

  for (const [name, endpoint] of Object.entries(endpoints)) {
    const endpointHeaders = resolveHeaders(endpoint.requestOptions?.headers);
    const { headers: _eh, ...endpointRestOptions } = endpoint.requestOptions ?? {};

    // The runtime function handles both call signatures:
    //   zero-option:  (requestOptions?)
    //   with-options: (options, requestOptions?)
    const endpointFn = async (
      optionsOrRequestOptions?: Record<string, unknown> | RequestOptions<E>,
      maybeRequestOptions?: RequestOptions<E>,
    ): Promise<Result<unknown, ApiErrors<E>>> => {
      // Determine which arg is which based on whether the endpoint has schema keys
      const hasSchemaOptions = ["input", "params", "query"].some(
        (k) => k in endpoint && endpoint[k as keyof Endpoint] !== undefined
      );

      const schemaOptions = hasSchemaOptions
        ? (optionsOrRequestOptions as { input?: unknown; params?: Record<string, unknown>; query?: Record<string, unknown> } | undefined)
        : undefined;

      const callRequestOptions: RequestOptions<E> | undefined = hasSchemaOptions
        ? maybeRequestOptions
        : (optionsOrRequestOptions as RequestOptions<E> | undefined);

      const callHeaders = resolveHeaders(callRequestOptions?.headers);
      const { headers: _ch, retry, ...callRestOptions } = callRequestOptions ?? {};

      // --- Validation phase (plain async, returns Result early on error) ---
      let validatedInput = schemaOptions?.input;
      if (
        validateInput &&
        endpoint.method !== "GET" &&
        "input" in endpoint &&
        endpoint.input
      ) {
        const inputResult = endpoint.input.safeParse(schemaOptions?.input);
        if (!inputResult.success) {
          return Result.err(
            new InputValidationError({
              message: "Invalid input",
              zodError: inputResult.error,
            })
          );
        }
        validatedInput = inputResult.data;
      }

      let validatedParams: Record<string, unknown> | undefined =
        schemaOptions?.params;
      if (validateInput && endpoint.params) {
        const paramsResult = endpoint.params.safeParse(schemaOptions?.params);
        if (!paramsResult.success) {
          return Result.err(
            new InputValidationError({
              message: "Invalid params",
              zodError: paramsResult.error,
            })
          );
        }
        validatedParams = paramsResult.data as Record<string, unknown>;
      }

      let validatedQuery: Record<string, unknown> | undefined =
        schemaOptions?.query;
      if (validateInput && endpoint.query) {
        const queryResult = endpoint.query.safeParse(schemaOptions?.query);
        if (!queryResult.success) {
          return Result.err(
            new InputValidationError({
              message: "Invalid query",
              zodError: queryResult.error,
            })
          );
        }
        validatedQuery = queryResult.data as Record<string, unknown>;
      }

      // --- Build URL and merged options (sync) ---
      const url = buildUrl({
        baseUrl,
        params: validatedParams,
        path: endpoint.path,
        query: validatedQuery,
      });

      const mergedRestOptions = {
        ...globalRestOptions,
        ...endpointRestOptions,
        ...callRestOptions,
      };

      const headers = mergeHeaders(authHeader, globalHeaders, endpointHeaders, callHeaders);

      // --- Core attempt: fetch + handle response (standalone Result.gen, no nesting) ---
      const attempt = (): Promise<Result<unknown, ApiErrors<E>>> => Result.gen(async function* attempt() {
        const response = yield* Result.await(
          makeRequest({
            headers,
            input: validatedInput,
            method: endpoint.method,
            requestOptions: mergedRestOptions,
            url,
          })
        );

        if (endpoint.stream?.enabled) {
          const stream = yield* Result.await(
            handleStreamResponse(
              response,
              endpoint.output,
              validateOutput,
              errorSchema,
              shouldValidateError
            )
          );
          return Result.ok(stream);
        }

        const outputSchema = endpoint.output ?? z.unknown();
        const result = yield* Result.await(
          handleJsonResponse(
            response,
            outputSchema,
            validateOutput,
            errorSchema,
            shouldValidateError
          )
        );
        return Result.ok(result);
      });

      // --- No retry: single attempt ---
      if (!retry) {
        return attempt();
      }

      return withRetry(attempt, retry);
    };

    (client as Record<string, unknown>)[name] = endpointFn;
  }

  return client;
};

export const createEndpoints = <T extends Record<string, Endpoint>>(
  endpoints: T
) => endpoints;

/**
 * Creates an API service base class with typed endpoints and optional error schema.
 *
 * @example
 * ```ts
 * class MyService extends ApiService(endpoints, errorSchema) {
 *   constructor(baseUrl: string) {
 *     super({ baseUrl, auth: { type: "bearer", token: "..." } });
 *   }
 * }
 * ```
 */
export const ApiService = <T extends Record<string, Endpoint>, E = unknown>(
  endpoints: T,
  errorSchema?: z.ZodType<E>
) =>
  class ApiServiceClass {
    protected readonly client: ApiClient<T, E>;

    constructor(
      options: Omit<
        Parameters<typeof createApi<T, E>>[0],
        "endpoints" | "errorSchema"
      >
    ) {
      this.client = createApi({ ...options, endpoints, errorSchema });
    }

    get api() {
      return this.client;
    }
  };
