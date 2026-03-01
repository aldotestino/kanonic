import type { Result } from "better-result";
import type { z } from "zod";

import type {
  ApiError,
  FetchError,
  InputValidationError,
  OutputValidationError,
  ParseError,
} from "./errors";

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
export interface RetryOptions<E = unknown> {
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
}

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
export type RequestOptions<E = unknown> = Omit<
  RequestInit,
  "body" | "method"
> & {
  retry?: RetryOptions<E>;
};

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Base endpoint properties shared by all methods
export interface BaseEndpoint {
  path: `/${string}`;
  query?: z.ZodType;
  params?: z.ZodType;
  output?: z.ZodType;
  stream?: { enabled: boolean };
  /** Fetch options applied to every call of this endpoint (retry is ignored here). */
  requestOptions?: Omit<RequestOptions, "retry">;
}

// GET endpoint (no input body)
export type GetEndpoint = BaseEndpoint & {
  method: "GET";
};

// Non-GET endpoint (can have input body)
export type NonGetEndpoint = BaseEndpoint & {
  method: Exclude<Method, "GET">;
  input?: z.ZodType;
};

export type Endpoint = GetEndpoint | NonGetEndpoint;

/**
 * A recursive tree of endpoints. Leaves are `Endpoint` objects; nodes are
 * plain objects grouping related endpoints.
 *
 * @example
 * ```ts
 * const endpoints = createEndpoints({
 *   todos: {
 *     list:   { method: "GET",  path: "/todos",    output: todoSchema },
 *     create: { method: "POST", path: "/todos",    input: newTodoSchema, output: todoSchema },
 *     get:    { method: "GET",  path: "/todos/:id", params: z.object({ id: z.number() }), output: todoSchema },
 *   },
 *   users: {
 *     list: { method: "GET", path: "/users", output: z.array(userSchema) },
 *   },
 * });
 *
 * // Usage:
 * await api.todos.list()
 * await api.todos.create({ input: { title: "Buy milk" } })
 * await api.users.list()
 * ```
 */
export interface EndpointTree {
  [key: string]: Endpoint | EndpointTree;
}

// Distinguishes a leaf Endpoint from a nested group at the type level.
// An Endpoint always has a `method` property; a group never does.
export type IsEndpoint<T> = T extends { method: Method } ? true : false;

// All possible API errors
export type ApiErrors<E = unknown> =
  | FetchError
  | ApiError<E>
  | ParseError
  | OutputValidationError
  | InputValidationError;

// Build the options object type for an endpoint
export type EndpointOptions<E extends Endpoint> = (E extends NonGetEndpoint
  ? E["input"] extends z.ZodType
    ? { input: z.infer<E["input"]> }
    : {}
  : {}) &
  (E["params"] extends z.ZodType ? { params: z.infer<E["params"]> } : {}) &
  (E["query"] extends z.ZodType ? { query: z.infer<E["query"]> } : {});

// Determine the success return type based on output schema
export type EndpointOutput<E extends Endpoint> = E["output"] extends z.ZodType
  ? z.infer<E["output"]>
  : unknown;

// Check if streaming is enabled
export type IsStreamEnabled<E extends Endpoint> = E["stream"] extends {
  enabled: true;
}
  ? true
  : false;

// Determine stream element type based on output schema
export type StreamElementType<E extends Endpoint> =
  E["output"] extends z.ZodType ? z.infer<E["output"]> : string;

// Return type: ReadableStream<T> when streaming, otherwise the output type
export type EndpointReturn<E extends Endpoint> =
  IsStreamEnabled<E> extends true
    ? ReadableStream<StreamElementType<E>>
    : EndpointOutput<E>;

export type ResultPromise<E extends Endpoint, ErrType> = Promise<
  Result<EndpointReturn<E>, ApiErrors<ErrType>>
>;

/**
 * Function signature for an endpoint with no schema options (no input/params/query).
 * The single optional argument is per-call RequestOptions.
 *
 *   api.listUsers()
 *   api.listUsers({ signal: controller.signal })
 */
export type ZeroOptionEndpointFunction<E extends Endpoint, ErrType> = (
  requestOptions?: RequestOptions<ErrType>
) => ResultPromise<E, ErrType>;

/**
 * Function signature for an endpoint that requires schema options.
 * The second optional argument is per-call RequestOptions.
 *
 *   api.getUser({ params: { id: 1 } })
 *   api.getUser({ params: { id: 1 } }, { signal: controller.signal })
 */
export type OptionEndpointFunction<E extends Endpoint, ErrType> = (
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

/**
 * Recursively maps an EndpointTree to a client object:
 * - leaf Endpoint  → EndpointFunction
 * - nested group   → ApiClient (recursed)
 */
export type ApiClient<T extends EndpointTree, E = unknown> = {
  [K in keyof T]: IsEndpoint<T[K]> extends true
    ? T[K] extends Endpoint
      ? EndpointFunction<T[K], E>
      : never
    : T[K] extends EndpointTree
      ? ApiClient<T[K], E>
      : never;
};

export type Auth =
  | {
      type: "bearer";
      token: string;
    }
  | {
      type: "basic";
      username: string;
      password: string;
    };

/**
 * The request context passed to plugin hooks. Contains everything that will
 * be forwarded to `fetch` after all option merging has been applied.
 *
 * Hooks receive this object by reference and may mutate it; each plugin in the
 * chain sees the version produced by the previous plugin.
 */
export interface RequestContext {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Any additional RequestInit fields (signal, credentials, mode, …). */
  [key: string]: unknown;
}

/**
 * A plugin that hooks into the kanonic request lifecycle.
 *
 * Plugins are registered globally via `createApi({ plugins: [...] })` and
 * apply to every endpoint. They are applied in array order — each hook
 * receives the context as mutated by all previous plugins in the chain.
 *
 * @example
 * ```ts
 * // Logger plugin (side-effects only)
 * const logger: Plugin = {
 *   id: "logger",
 *   name: "Logger",
 *   version: "1.0.0",
 *   hooks: {
 *     onRequest:  async (ctx) => { console.log("→", ctx.method, ctx.url); return ctx; },
 *     onResponse: async (ctx, res) => { console.log("←", res.status); return res; },
 *     onSuccess:  async (ctx, res, data) => { console.log("✓", res.status, data); },
 *     onError:    async (ctx, err) => { console.error("✗", err._tag); },
 *   },
 * };
 * ```
 */
export interface Plugin<E = unknown> {
  /** Unique identifier for this plugin instance. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semver string, e.g. `"1.0.0"`. */
  version: string;
  /**
   * Called once per endpoint invocation, **before** the first attempt.
   * Receives the fully-resolved URL and the merged `RequestInit` options.
   * May return a modified `{ url, options }` — useful for adding trace IDs,
   * signing requests, or rewriting URLs.
   *
   * Runs even when `retry` is configured; it is NOT re-run on each retry.
   */
  init?: (
    url: string,
    options: RequestInit
  ) => Promise<{ url: string; options: RequestInit }>;
  hooks?: {
    /**
     * Fires at the start of **each attempt** (including retries), after `init`.
     * Receives the current `RequestContext` and must return it (optionally
     * mutated). Mutations are visible to all subsequent plugins and to `fetch`.
     */
    onRequest?: (ctx: RequestContext) => Promise<RequestContext>;
    /**
     * Fires after every `fetch` response, on **each attempt**.
     * Receives the `RequestContext` (as produced by `onRequest`) and the raw
     * `Response`. Must return a `Response` — can be the same object or a
     * cloned/replaced one.
     */
    onResponse?: (ctx: RequestContext, response: Response) => Promise<Response>;
    /**
     * Fires **once**, after the entire retry loop resolves successfully.
     * Cannot modify the data. Intended for logging, metrics, tracing, etc.
     */
    onSuccess?: (
      ctx: RequestContext,
      response: Response,
      data: unknown
    ) => Promise<void>;
    /**
     * Fires **once**, after the entire retry loop resolves with an error.
     * Cannot modify the error. Intended for logging, metrics, tracing, etc.
     */
    onError?: (ctx: RequestContext, error: ApiErrors<E>) => Promise<void>;
    /**
     * Fires inside the retry loop, just before the sleep delay, when an
     * attempt fails and will be retried. Cannot modify anything.
     */
    onRetry?: (
      ctx: RequestContext,
      error: FetchError | ApiError<E>
    ) => Promise<void>;
  };
}
