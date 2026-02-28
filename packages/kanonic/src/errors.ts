import type { z } from "zod";

import { TaggedError } from "better-result";

/**
 * API error returned when response status code >= 400.
 * Contains statusCode, raw text, optional parsed data, and optional cause.
 *
 * @template T - The type of the parsed error data (when errorSchema provided)
 */
export class ApiError<T = unknown> extends TaggedError("ApiError")<{
  readonly statusCode: number;
  readonly text: string;
  readonly data?: unknown;
  readonly cause?: unknown;
}>() {
  declare readonly data: T | undefined;
}

// the fetch request failed
export class FetchError extends TaggedError("FetchError")<{
  readonly message: string;
  readonly cause?: unknown;
}>() {}

export class ParseError extends TaggedError("ParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}>() {}

// the input to the api was invalid
export class InputValidationError extends TaggedError("InputValidationError")<{
  readonly message: string;
  readonly zodError: z.ZodError;
}>() {}

// the output from the api was invalid
export class OutputValidationError extends TaggedError(
  "OutputValidationError"
)<{
  readonly message: string;
  readonly zodError: z.ZodError;
}>() {}
