import type {
  OkfetchError,
  OkfetchOptions,
  OkfetchResponse,
} from "@okfetch/fetch";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Result } from "better-result";

type InferInput<TSchema extends StandardSchemaV1> =
  StandardSchemaV1.InferInput<TSchema>;

type InferOutput<TSchema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<TSchema>;

export type EndpointRequestOverrides = Omit<
  OkfetchOptions,
  | "_retryAttempt"
  | "apiErrorDataSchema"
  | "baseURL"
  | "body"
  | "errorSchema"
  | "method"
  | "outputSchema"
  | "params"
  | "query"
  | "stream"
>;

type EndpointRequestDefaults = Omit<
  EndpointRequestOverrides,
  "includeResponse"
>;

export type EndpointDefinition = {
  method: NonNullable<OkfetchOptions["method"]>;
  path: `/${string}`;
  body?: StandardSchemaV1;
  error?: StandardSchemaV1;
  output?: StandardSchemaV1;
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  requestOptions?: EndpointRequestDefaults;
  stream?: true;
};

export type EndpointTree = {
  [key: string]: EndpointDefinition | EndpointTree;
};

export type EndpointCallOptions<TEndpoint extends EndpointDefinition> =
  Prettify<
    (TEndpoint["body"] extends StandardSchemaV1
      ? { body: InferInput<TEndpoint["body"]> }
      : {}) &
      (TEndpoint["params"] extends StandardSchemaV1
        ? { params: InferInput<TEndpoint["params"]> }
        : {}) &
      (TEndpoint["query"] extends StandardSchemaV1
        ? { query: InferInput<TEndpoint["query"]> }
        : {})
  >;

export type EndpointOutput<TEndpoint extends EndpointDefinition> =
  TEndpoint["output"] extends StandardSchemaV1
    ? InferOutput<TEndpoint["output"]>
    : unknown;

export type EndpointError<
  TEndpoint extends EndpointDefinition,
  TGlobalError,
> = TEndpoint["error"] extends StandardSchemaV1
  ? InferOutput<TEndpoint["error"]>
  : TGlobalError;

export type EndpointSuccess<TEndpoint extends EndpointDefinition> =
  TEndpoint["stream"] extends true
    ? ReadableStream<
        TEndpoint["output"] extends StandardSchemaV1
          ? InferOutput<TEndpoint["output"]>
          : string
      >
    : EndpointOutput<TEndpoint>;

export type EndpointResult<
  TEndpoint extends EndpointDefinition,
  TGlobalError,
  TIncludeResponse extends boolean = false,
> = Promise<
  Result<
    TIncludeResponse extends true
      ? OkfetchResponse<EndpointSuccess<TEndpoint>>
      : EndpointSuccess<TEndpoint>,
    OkfetchError<EndpointError<TEndpoint, TGlobalError>>
  >
>;

type IncludeResponseValue<TOptions> = TOptions extends {
  includeResponse?: infer TIncludeResponse extends boolean;
}
  ? TIncludeResponse
  : never;

type IncludesResponse<TOptions> = TOptions extends object
  ? "includeResponse" extends keyof TOptions
    ? IncludeResponseValue<TOptions>
    : false
  : false;

export type ZeroOptionEndpointFunction<
  TEndpoint extends EndpointDefinition,
  TGlobalError,
> = <TOverrides extends EndpointRequestOverrides | undefined = undefined>(
  requestOverrides?: TOverrides
) => EndpointResult<TEndpoint, TGlobalError, IncludesResponse<TOverrides>>;

export type OptionEndpointFunction<
  TEndpoint extends EndpointDefinition,
  TGlobalError,
> = <TOverrides extends EndpointRequestOverrides | undefined = undefined>(
  options: EndpointCallOptions<TEndpoint>,
  requestOverrides?: TOverrides
) => EndpointResult<TEndpoint, TGlobalError, IncludesResponse<TOverrides>>;

export type EndpointFunction<
  TEndpoint extends EndpointDefinition,
  TGlobalError,
> = keyof EndpointCallOptions<TEndpoint> extends never
  ? ZeroOptionEndpointFunction<TEndpoint, TGlobalError>
  : OptionEndpointFunction<TEndpoint, TGlobalError>;

export type ApiClient<TTree extends EndpointTree, TGlobalError = unknown> = {
  [TKey in keyof TTree]: TTree[TKey] extends EndpointDefinition
    ? EndpointFunction<TTree[TKey], TGlobalError>
    : TTree[TKey] extends EndpointTree
      ? ApiClient<TTree[TKey], TGlobalError>
      : never;
};

export type CreateApiOptions<
  TTree extends EndpointTree,
  TGlobalError = unknown,
> = Prettify<
  EndpointRequestDefaults & {
    baseURL: string;
    endpoints: TTree;
    errorSchema?: StandardSchemaV1<unknown, TGlobalError>;
    shouldValidateError?: (statusCode: number) => boolean;
    validateInput?: boolean;
    validateOutput?: boolean;
  }
>;

export type ApiServiceClass<
  TTree extends EndpointTree,
  TGlobalError = unknown,
> = new (
  options: Omit<
    CreateApiOptions<TTree, TGlobalError>,
    "endpoints" | "errorSchema"
  >
) => {
  readonly api: ApiClient<TTree, TGlobalError>;
};

type Prettify<TValue> = {
  [TKey in keyof TValue]: TValue[TKey];
} & {};
