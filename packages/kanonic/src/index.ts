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
    ParseError
};

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
export type ApiErrors =
  | FetchError
  | ApiError
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

// Return type: ReadableStream<string> when streaming, otherwise the output type
type EndpointReturn<E extends Endpoint> =
  IsStreamEnabled<E> extends true ? ReadableStream<string> : EndpointOutput<E>;

// Function signature: options required only if EndpointOptions is non-empty
type EndpointFunction<E extends Endpoint> =
  keyof EndpointOptions<E> extends never
    ? () => ResultAsync<EndpointReturn<E>, ApiErrors>
    : (
        options: EndpointOptions<E>
      ) => ResultAsync<EndpointReturn<E>, ApiErrors>;

// The final API client type
export type ApiClient<T extends Record<string, Endpoint>> = {
  [K in keyof T]: EndpointFunction<T[K]>;
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

const handleJsonResponse = (
  response: Response,
  outputSchema: z.ZodType,
  validateOutput: boolean,
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
      return err(new ApiError({ statusCode: response.status, text: text }));
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

const handleStreamResponse = (response: Response) =>
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
      return err(new ApiError({ statusCode: response.status, text }));
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

    const stream = new ReadableStream<string>({
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
              const data = extractDataLine(line);
              if (data !== null) {
                controller.enqueue(data);
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
          const data = extractDataLine(line);
          if (data !== null) {
            controller.enqueue(data);
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

export const createApi = <T extends Record<string, Endpoint>>({
  baseUrl,
  endpoints,
  headers,
  auth,
  validateOutput = true,
}: {
  baseUrl: string;
  endpoints: T;
  headers?: Record<string, string>;
  auth?: Auth;
  validateOutput?: boolean;
}): ApiClient<T> => {
  const finalHeaders = buildHeaders({ auth, headers });

  const client = {} as ApiClient<T>;

  for (const [name, endpoint] of Object.entries(endpoints)) {
    const endpointFn = (options?: {
      input?: unknown;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
    }) =>
      safeTry(async function* endpointFn() {
        // Validate input if schema exists (only for non-GET)
        let validatedInput;
        if (
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
        let validatedParams: Record<string, unknown> | undefined;
        if (endpoint.params) {
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
        let validatedQuery: Record<string, unknown> | undefined;
        if (endpoint.query) {
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
          const stream = yield* handleStreamResponse(response);
          return ok(stream);
        }

        // Handle response with output validation
        const outputSchema = endpoint.output ?? z.unknown();
        const result = yield* handleJsonResponse(
          response,
          outputSchema,
          validateOutput,
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

export const ApiService = <T extends Record<string, Endpoint>>(endpoints: T) =>
  class ApiServiceClass {
    protected readonly client: ApiClient<T>;

    constructor(options: Omit<Parameters<typeof createApi>[0], "endpoints">) {
      this.client = createApi({ ...options, endpoints });
    }

    get api() {
      return this.client;
    }
  };
