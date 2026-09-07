import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TaggedError } from "better-result";

export class FetchError extends TaggedError("FetchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ParseError extends TaggedError("ParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ValidationError extends TaggedError("ValidationError")<{
  readonly type: "output" | "error" | "query" | "params" | "body";
  readonly message: string;
  readonly issues: readonly StandardSchemaV1.Issue[];
}> {}

export class ApiError<T = unknown> extends TaggedError("ApiError")<{
  readonly statusCode: number;
  readonly statusText: string;
  readonly text?: string;
  readonly data?: unknown;
  readonly response?: Response;
}> {
  declare readonly data: T | undefined;
}

export class TimeoutError extends TaggedError("TimeoutError")<{
  readonly timout: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PluginError extends TaggedError("PluginError")<{
  readonly pluginName: string;
  readonly hook: "init" | "onRequest" | "onResponse";
  readonly message: string;
  readonly cause?: unknown;
}> {}
