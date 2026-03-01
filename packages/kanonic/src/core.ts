import { Result } from "better-result";
import { z } from "zod";

import {
  InputValidationError,
  OutputValidationError,
  ParseError,
} from "./errors";
import type {
  ApiClient,
  ApiErrors,
  Auth,
  Endpoint,
  EndpointTree,
  RequestOptions,
} from "./types";
import {
  buildAuthHeader,
  buildUrl,
  extractDataLine,
  isEndpoint,
  parseErrorResponse,
  processStreamChunk,
  safeFetch,
  safeJsonParse,
  withRetry,
} from "./utils";

const handleJsonResponse = <E>(
  response: Response,
  outputSchema: z.ZodType,
  validateOutput: boolean,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
) =>
  Result.gen(async function* () {
    const text = yield* Result.await(
      Result.tryPromise({
        catch: (error) =>
          new ParseError({
            cause: error,
            message:
              error instanceof Error ? error.message : "Something went wrong",
          }),
        try: () => response.text(),
      })
    );

    if (!response.ok) {
      return Result.err(
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
  Result.gen(async function* () {
    if (!response.ok) {
      const text = yield* Result.await(
        Result.tryPromise({
          catch: (error) =>
            new ParseError({
              cause: error,
              message:
                error instanceof Error ? error.message : "Something went wrong",
            }),
          try: () => response.text(),
        })
      );
      return Result.err(
        parseErrorResponse(
          text,
          response.status,
          errorSchema,
          shouldValidateError
        )
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

    return Result.ok(stream);
  });

// Builds the endpoint function for a single leaf endpoint
const buildEndpointFn = <E>(
  endpoint: Endpoint,
  baseUrl: string,
  authHeader: Record<string, string>,
  globalHeaders: RequestInit["headers"],
  globalRestOptions: Record<string, unknown>,
  validateInput: boolean,
  validateOutput: boolean,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
) => {
  const { headers: endpointHeaders, ...endpointRestOptions } =
    endpoint.requestOptions ?? {};

  return async (
    optionsOrRequestOptions?: Record<string, unknown> | RequestOptions<E>,
    maybeRequestOptions?: RequestOptions<E>
  ): Promise<Result<unknown, ApiErrors<E>>> => {
    const hasSchemaOptions = ["input", "params", "query"].some(
      (k) => k in endpoint && endpoint[k as keyof Endpoint] !== undefined
    );

    const schemaOptions = hasSchemaOptions
      ? (optionsOrRequestOptions as
          | {
              input?: unknown;
              params?: Record<string, unknown>;
              query?: Record<string, unknown>;
            }
          | undefined)
      : undefined;

    const callRequestOptions: RequestOptions<E> | undefined = hasSchemaOptions
      ? maybeRequestOptions
      : (optionsOrRequestOptions as RequestOptions<E> | undefined);

    const {
      headers: callHeaders,
      retry,
      ...callRestOptions
    } = callRequestOptions ?? {};

    // --- Validation ---
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

    // --- Build URL and merged options ---
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

    const headers: RequestInit["headers"] = {
      ...authHeader,
      ...globalHeaders,
      ...endpointHeaders,
      ...callHeaders,
      "Content-Type": "application/json",
    };

    // --- Core attempt ---
    const attempt = (): Promise<Result<unknown, ApiErrors<E>>> =>
      Result.gen(async function* () {
        const response = yield* Result.await(
          safeFetch(url, {
            method: endpoint.method,
            headers,
            body:
              endpoint.method === "GET"
                ? undefined
                : JSON.stringify(validatedInput),
            ...mergedRestOptions,
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

    if (!retry) {
      return attempt();
    }

    return withRetry(attempt, retry);
  };
};

// Recursively builds the client object mirroring the endpoint tree shape
const buildClientNode = <E>(
  tree: EndpointTree,
  baseUrl: string,
  authHeader: Record<string, string>,
  globalHeaders: RequestInit["headers"],
  globalRestOptions: Record<string, unknown>,
  validateInput: boolean,
  validateOutput: boolean,
  errorSchema?: z.ZodType<E>,
  shouldValidateError?: (statusCode: number) => boolean
): Record<string, unknown> => {
  const node: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(tree)) {
    node[key] = isEndpoint(value)
      ? buildEndpointFn(
          value,
          baseUrl,
          authHeader,
          globalHeaders,
          globalRestOptions,
          validateInput,
          validateOutput,
          errorSchema,
          shouldValidateError
        )
      : buildClientNode(
          value as EndpointTree,
          baseUrl,
          authHeader,
          globalHeaders,
          globalRestOptions,
          validateInput,
          validateOutput,
          errorSchema,
          shouldValidateError
        );
  }

  return node;
};

/**
 * Creates a type-safe API client from endpoint definitions.
 * Supports both flat and nested endpoint trees.
 *
 * @example
 * ```ts
 * // Flat
 * const api = createApi({ baseUrl, endpoints: { getUser: { method: "GET", ... } } });
 * await api.getUser({ params: { id: 1 } });
 *
 * // Nested
 * const api = createApi({
 *   baseUrl,
 *   endpoints: {
 *     users: {
 *       list:   { method: "GET",  path: "/users",    output: z.array(userSchema) },
 *       get:    { method: "GET",  path: "/users/:id", params: z.object({ id: z.number() }), output: userSchema },
 *       create: { method: "POST", path: "/users",    input: newUserSchema, output: userSchema },
 *     },
 *   },
 * });
 * await api.users.list();
 * await api.users.get({ params: { id: 1 } });
 * ```
 */
export const createApi = <T extends EndpointTree, E = unknown>({
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
  const { headers: globalHeaders, ...globalRestOptions } =
    globalRequestOptions ?? {};

  return buildClientNode(
    endpoints,
    baseUrl,
    authHeader,
    globalHeaders,
    globalRestOptions,
    validateInput,
    validateOutput,
    errorSchema,
    shouldValidateError
  ) as ApiClient<T, E>;
};

/**
 * Identity function that infers and preserves the full static type of an
 * endpoint tree (flat or nested).
 *
 * @example
 * ```ts
 * const endpoints = createEndpoints({
 *   todos: {
 *     list:   { method: "GET",  path: "/todos",    output: todoSchema },
 *     create: { method: "POST", path: "/todos",    input: newTodoSchema, output: todoSchema },
 *   },
 * });
 * ```
 */
export const createEndpoints = <T extends EndpointTree>(endpoints: T) =>
  endpoints;

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
export const ApiService = <T extends EndpointTree, E = unknown>(
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
