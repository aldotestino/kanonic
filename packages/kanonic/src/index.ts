// oxlint-disable no-array-for-each
// oxlint-disable max-statements
// oxlint-disable prefer-await-to-callbacks
// oxlint-disable ban-types
// oxlint-disable no-empty-object-type

import { err, ok, Result, ResultAsync, safeTry } from "neverthrow";
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
  ParseError,
};

/**
 * Preset validation function that validates only client errors (4xx status codes).
 * This is the default behavior when errorSchema is provided but shouldValidateError is not.
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

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Base endpoint properties shared by all methods
interface BaseEndpoint {
  path: `/${string}`;
  query?: z.ZodType;
  params?: z.ZodType;
  output?: z.ZodType;
  stream?: { enabled: boolean };
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

// Return type: ReadableStream<T> when streaming (typed if output schema exists), otherwise the output type
type EndpointReturn<E extends Endpoint> =
  IsStreamEnabled<E> extends true
    ? ReadableStream<StreamElementType<E>>
    : EndpointOutput<E>;

// Function signature: options required only if EndpointOptions is non-empty
type EndpointFunction<
  E extends Endpoint,
  ErrType = unknown,
> = keyof EndpointOptions<E> extends never
  ? () => ResultAsync<EndpointReturn<E>, ApiErrors<ErrType>>
  : (
      options: EndpointOptions<E>
    ) => ResultAsync<EndpointReturn<E>, ApiErrors<ErrType>>;

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

const buildHeaders = ({
  headers,
  auth,
}: {
  headers?: Record<string, string>;
  auth?: Auth;
}) => {
  const finalHeaders = { ...headers };
  if (auth) {
    if (auth.type === "bearer") {
      finalHeaders["Authorization"] = `Bearer ${auth.token}`;
    } else if (auth.type === "basic") {
      finalHeaders["Authorization"] =
        `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
    }
  }
  return finalHeaders;
};

const safeFetch = ResultAsync.fromThrowable(
  fetch,
  (error) =>
    new FetchError({
      cause: error,
      message: error instanceof Error ? error.message : "Something went wrong",
    })
);

const safeJsonParse = Result.fromThrowable(
  JSON.parse,
  (error) =>
    new ParseError({
      cause: error,
      message: error instanceof Error ? error.message : "Failed to parse JSON",
    })
);

const parseErrorResponse = <E>(
  text: string,
  statusCode: number,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
): ApiError<E> => {
  // No schema provided - return with just text (current behavior)
  if (!errorSchema) {
    return new ApiError<E>({ statusCode, text });
  }

  // Default: only validate 4xx (client errors)
  const shouldValidate = shouldValidateError
    ? shouldValidateError(statusCode)
    : statusCode >= 400 && statusCode < 500;

  if (!shouldValidate) {
    return new ApiError<E>({ statusCode, text });
  }

  // Try to parse JSON
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON parse failed - fallback to text only
    return new ApiError<E>({ statusCode, text });
  }

  // Validate with zod schema
  const result = errorSchema.safeParse(json);
  if (result.success) {
    // Validation succeeded - include parsed data
    return new ApiError<E>({
      data: result.data,
      statusCode,
      text,
    });
  }

  // Validation failed - fallback to text only
  return new ApiError<E>({ statusCode, text });
};

const makeRequest = ({
  method,
  url,
  headers,
  input,
}: {
  method: Method;
  url: string;
  headers?: Record<string, string>;
  input?: unknown;
}) =>
  safeFetch(url, {
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
  safeTry(async function* handleJsonResponse() {
    const text = yield* await ResultAsync.fromPromise(
      response.text(),
      (error) =>
        new ParseError({
          cause: error,
          message:
            error instanceof Error ? error.message : "Something went wrong",
        })
    );

    if (!response.ok) {
      return err(
        parseErrorResponse(
          text,
          response.status,
          errorSchema,
          shouldValidateError
        )
      );
    }

    const json = yield* safeJsonParse(text);

    if (!validateOutput) {
      return ok(json);
    }

    const { success, data, error } = outputSchema.safeParse(json);

    if (!success) {
      return err(
        new OutputValidationError({
          message: "The output from the api was invalid",
          zodError: error,
        })
      );
    }

    return ok(data);
  });

const handleStreamResponse = <E>(
  response: Response,
  outputSchema?: z.ZodType,
  validateOutput = true,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
) =>
  safeTry(async function* handleStreamResponse() {
    if (!response.ok) {
      const text = yield* await ResultAsync.fromPromise(
        response.text(),
        (error) =>
          new ParseError({
            cause: error,
            message:
              error instanceof Error ? error.message : "Something went wrong",
          })
      );
      return err(
        parseErrorResponse(
          text,
          response.status,
          errorSchema,
          shouldValidateError
        )
      );
    }

    if (!response.body) {
      return err(
        new ParseError({
          message: "Response body is null",
        })
      );
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
          // Process any remaining buffer
          if (buffer.trim()) {
            const lines = buffer.split("\n");
            for (const line of lines) {
              const dataContent = extractDataLine(line);
              if (dataContent !== null) {
                const processedData = processStreamChunk(
                  dataContent,
                  outputSchema,
                  validateOutput
                );
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
        // Keep the last incomplete line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const dataContent = extractDataLine(line);
          if (dataContent !== null) {
            const processedData = processStreamChunk(
              dataContent,
              outputSchema,
              validateOutput
            );
            if (processedData !== null) {
              controller.enqueue(processedData);
            }
          }
        }
      },
    });

    return ok(stream);
  });

// Extract data content from SSE "data:" lines, returns null for non-data lines
const extractDataLine = (line: string): string | null => {
  const trimmed = line.trim();

  // Only process "data:" lines (SSE format)
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const dataContent = trimmed.slice(5).trim();

  // Skip empty data or [DONE] markers
  if (!dataContent || dataContent === "[DONE]") {
    return null;
  }

  return dataContent;
};

// Process a stream chunk: parse JSON and optionally validate
// Returns null for invalid chunks (which will be skipped)
const processStreamChunk = (
  dataContent: string,
  outputSchema?: z.ZodType,
  validateOutput = true
): unknown => {
  // If no output schema provided, return raw string
  if (!outputSchema) {
    return dataContent;
  }

  // Always parse JSON when output schema exists
  let processedData: unknown;
  try {
    processedData = JSON.parse(dataContent);
  } catch (error) {
    // Skip invalid JSON chunks
    console.warn("Failed to parse JSON chunk:", error);
    return null;
  }

  // Validate if validateOutput is enabled
  if (validateOutput) {
    const result = outputSchema.safeParse(processedData);
    if (!result.success) {
      // Skip invalid chunks
      console.warn("Validation failed for chunk:", result.error);
      return null;
    }
    processedData = result.data;
  }

  return processedData;
};

/**
 * Creates a type-safe API client from endpoint definitions.
 *
 * Configuration options:
 * - baseUrl: Base URL for all API requests
 * - endpoints: Endpoint definitions created with createEndpoints
 * - headers: Optional default headers for all requests
 * - auth: Optional authentication configuration (bearer or basic)
 * - validateOutput: Whether to validate response data (default: true)
 * - validateInput: Whether to validate request data (default: true)
 * - errorSchema: Optional Zod schema for error response validation
 * - shouldValidateError: Function to control which status codes to validate (default: 4xx only)
 *
 * @example
 * ```ts
 * const errorSchema = z.object({
 *   message: z.string(),
 *   code: z.string().optional()
 * });
 *
 * const api = createApi({
 *   baseUrl: "https://api.example.com",
 *   endpoints,
 *   errorSchema,
 *   shouldValidateError: (code) => code >= 400 && code < 500
 * });
 * ```
 */
export const createApi = <T extends Record<string, Endpoint>, E = unknown>({
  baseUrl,
  endpoints,
  headers,
  auth,
  validateOutput = true,
  validateInput = true,
  errorSchema,
  shouldValidateError,
}: {
  baseUrl: string;
  endpoints: T;
  headers?: Record<string, string>;
  auth?: Auth;
  validateOutput?: boolean;
  validateInput?: boolean;
  errorSchema?: z.ZodType<E>;
  shouldValidateError?: (statusCode: number) => boolean;
}): ApiClient<T, E> => {
  const finalHeaders = buildHeaders({ auth, headers });

  const client = {} as ApiClient<T, E>;

  for (const [name, endpoint] of Object.entries(endpoints)) {
    // oxlint-disable complexity
    const endpointFn = (options?: {
      input?: unknown;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
    }) =>
      safeTry(async function* endpointFn() {
        let validatedInput = options?.input;
        if (
          validateInput &&
          endpoint.method !== "GET" &&
          "input" in endpoint &&
          endpoint.input
        ) {
          const inputResult = endpoint.input.safeParse(options?.input);
          if (!inputResult.success) {
            return err(
              new InputValidationError({
                message: "Invalid input",
                zodError: inputResult.error,
              })
            );
          }
          validatedInput = inputResult.data;
        }

        // Validate params if schema exists
        let validatedParams: Record<string, unknown> | undefined =
          options?.params as Record<string, unknown> | undefined;
        if (validateInput && endpoint.params) {
          const paramsResult = endpoint.params.safeParse(options?.params);
          if (!paramsResult.success) {
            return err(
              new InputValidationError({
                message: "Invalid params",
                zodError: paramsResult.error,
              })
            );
          }
          validatedParams = paramsResult.data as Record<string, unknown>;
        }

        // Validate query if schema exists
        let validatedQuery: Record<string, unknown> | undefined =
          options?.query as Record<string, unknown> | undefined;
        if (validateInput && endpoint.query) {
          const queryResult = endpoint.query.safeParse(options?.query);
          if (!queryResult.success) {
            return err(
              new InputValidationError({
                message: "Invalid query",
                zodError: queryResult.error,
              })
            );
          }
          validatedQuery = queryResult.data as Record<string, unknown>;
        }

        const url = buildUrl({
          baseUrl,
          params: validatedParams,
          path: endpoint.path,
          query: validatedQuery,
        });

        const response = yield* makeRequest({
          headers: {
            "Content-Type": "application/json",
            ...finalHeaders,
          },
          input: validatedInput,
          method: endpoint.method,
          url,
        });

        // Check if streaming is enabled
        if (endpoint.stream?.enabled) {
          const stream = yield* handleStreamResponse(
            response,
            endpoint.output,
            validateOutput,
            errorSchema,
            shouldValidateError
          );
          return ok(stream);
        }

        // Handle response with output validation
        const outputSchema = endpoint.output ?? z.unknown();
        const result = yield* handleJsonResponse(
          response,
          outputSchema,
          validateOutput,
          errorSchema,
          shouldValidateError
        );

        return ok(result);
      });

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
 * const errorSchema = z.object({ message: z.string() });
 *
 * class MyService extends ApiService(endpoints, errorSchema) {
 *   constructor(baseUrl: string) {
 *     super({ baseUrl });
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
