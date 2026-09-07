import type {
  StandardSchemaV1,
  StandardSchemaV1 as _StandardSchemaV1,
} from "@standard-schema/spec";

import type {
  ApiError,
  FetchError,
  ParseError,
  PluginError,
  TimeoutError,
  ValidationError,
} from "./errors";
import type { Prettify } from "./type-utils";

export type OkfetchError<TErr> =
  | FetchError
  | ApiError<TErr>
  | ParseError
  | PluginError
  | ValidationError
  | TimeoutError;

export type RetryableOkfetchError =
  | FetchError
  | ApiError<unknown>
  | TimeoutError;

type BasicAuth = {
  type: "basic";
  username: string;
  password: string;
};

type BearerAuth = {
  type: "bearer";
  token: string;
};

type CustomAuth = {
  type: "custom";
  prefix: string;
  value: string;
};

export type Auth = BasicAuth | BearerAuth | CustomAuth;

export type NonBodyMethods = "HEAD" | "OPTIONS";
export type BodyMethods = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "QUERY";
export type Method = BodyMethods | NonBodyMethods;

type FixedRetryOptions = {
  strategy: "fixed";
  /** Maximum number of retry attempts. */
  attempts: number;
  /** Delay in milliseconds between retries. Defaults to 0. */
  delay?: number;
  /**
   * Optional callback to decide whether a given error should be retried.
   * If not provided, FetchError, TimeoutError, and ApiError with status >= 500
   * are retried by default.
   */
  shouldRetry?: (error: RetryableOkfetchError) => boolean;
};

type LinearRetryOptions = {
  strategy: "linear";
  /** Maximum number of retry attempts. */
  attempts: number;
  /** Delay for the first retry in milliseconds. Defaults to 100. */
  initialDelay?: number;
  /** Amount added to the delay on each subsequent attempt in milliseconds. Defaults to 100. */
  step?: number;
  /** Maximum delay in milliseconds. No cap if omitted. */
  maxDelay?: number;
  /**
   * Optional callback to decide whether a given error should be retried.
   * If not provided, FetchError, TimeoutError, and ApiError with status >= 500
   * are retried by default.
   */
  shouldRetry?: (error: RetryableOkfetchError) => boolean;
};

type ExponentialRetryOptions = {
  strategy: "exponential";
  /** Maximum number of retry attempts. */
  attempts: number;
  /** Initial delay in milliseconds for the first retry. Defaults to 100. */
  initialDelay?: number;
  /** Multiplier applied to the delay on each subsequent attempt. Defaults to 2. */
  factor?: number;
  /** Maximum delay in milliseconds. No cap if omitted. */
  maxDelay?: number;
  /**
   * Optional callback to decide whether a given error should be retried.
   * If not provided, FetchError, TimeoutError, and ApiError with status >= 500
   * are retried by default.
   */
  shouldRetry?: (error: RetryableOkfetchError) => boolean;
};

export type RetryOptions =
  | FixedRetryOptions
  | LinearRetryOptions
  | ExponentialRetryOptions;

export type OkfetchBody = Exclude<RequestInit["body"], undefined>;
export type OkfetchFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type StreamChunkValue<Options extends OkfetchOptions> =
  Options["outputSchema"] extends StandardSchemaV1
    ? InferOutput<Options["outputSchema"]>
    : unknown;

export type OkfetchResponse<TData> = {
  data: TData;
  response: Response;
};

type SuccessWithResponse<TData, TIncludeResponse> =
  TIncludeResponse extends true ? OkfetchResponse<TData> : TData;

export type OkfetchSuccess<
  Options extends OkfetchOptions,
  TRes = StreamChunkValue<Options>,
> = SuccessWithResponse<
  Options["stream"] extends true ? ReadableStream<TRes> : TRes,
  Options["includeResponse"]
>;

export type OkfetchPluginInitInput = {
  url: string;
  options: OkfetchOptions;
};

export type OkfetchRequestContext = Prettify<
  Omit<RequestInit, "body" | "headers" | "method" | "signal"> & {
    url: URL;
    method: Method | Uppercase<string>;
    headers: Headers;
    body?: OkfetchBody;
    signal: AbortSignal;
  }
>;

export type OkfetchPluginHooks<TData = unknown, TErr = unknown> = {
  onRequest?:
    | ((context: OkfetchRequestContext) => OkfetchRequestContext | undefined)
    | ((
        context: OkfetchRequestContext
      ) => Promise<OkfetchRequestContext | undefined>);
  onResponse?:
    | ((
        context: OkfetchRequestContext,
        response: Response
      ) => Response | undefined)
    | ((
        context: OkfetchRequestContext,
        response: Response
      ) => Promise<Response | undefined>);
  onSuccess?:
    | ((
        context: OkfetchRequestContext,
        response: Response,
        data: TData
      ) => void)
    | ((
        context: OkfetchRequestContext,
        response: Response,
        data: TData
      ) => Promise<void>);
  onFail?:
    | ((
        context: OkfetchRequestContext,
        response: Response | undefined,
        error: OkfetchError<TErr>
      ) => void)
    | ((
        context: OkfetchRequestContext,
        response: Response | undefined,
        error: OkfetchError<TErr>
      ) => Promise<void>);
  onRetry?:
    | ((
        context: OkfetchRequestContext,
        response: Response | undefined,
        error: RetryableOkfetchError,
        attempt: number
      ) => void)
    | ((
        context: OkfetchRequestContext,
        response: Response | undefined,
        error: RetryableOkfetchError,
        attempt: number
      ) => Promise<void>);
};

export type OkfetchPlugin<TData = unknown, TErr = unknown> = {
  name: string;
  version: string;
  init?:
    | ((input: OkfetchPluginInitInput) => OkfetchPluginInitInput | undefined)
    | ((
        input: OkfetchPluginInitInput
      ) => Promise<OkfetchPluginInitInput | undefined>);
  hooks?: OkfetchPluginHooks<TData, TErr>;
};

export type OkfetchOptions = Prettify<
  Omit<RequestInit, "body" | "headers"> & {
    method?: Method;
    headers?: Record<string, string>;
    auth?: Auth;
    outputSchema?: StandardSchemaV1;
    errorSchema?: StandardSchemaV1;
    apiErrorDataSchema?: StandardSchemaV1;
    baseURL?: string;
    params?: Record<string, string | number | boolean | undefined>;
    query?: Record<
      string,
      | string
      | number
      | boolean
      | undefined
      | (string | number | boolean | undefined)[]
    >;
    body?: unknown;
    fetch?: OkfetchFetch;
    /** Include the underlying Response alongside successful response data. */
    includeResponse?: boolean;
    timeout?: number;
    stream?: boolean;
    validateOutput?: boolean;
    /**
     * Limits which status codes get their parsed error body validated against
     * `apiErrorDataSchema`. Defaults to validating every error response when a
     * schema is set; excluded statuses still receive the parsed body, unvalidated.
     */
    shouldValidateError?: (statusCode: number) => boolean;
    plugins?: OkfetchPlugin[];
    /** Retry configuration. Supports "fixed", "linear" and "exponential" backoff strategies. */
    retry?: RetryOptions;
    /** @internal */
    _retryAttempt?: number;
  }
>;

export type InferInput<TSchema extends _StandardSchemaV1> =
  _StandardSchemaV1.InferInput<TSchema>;

export type InferOutput<TSchema extends _StandardSchemaV1> =
  _StandardSchemaV1.InferOutput<TSchema>;

export type { StandardSchemaV1 };
