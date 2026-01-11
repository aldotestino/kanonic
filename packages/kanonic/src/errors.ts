// oxlint-disable max-classes-per-file
// oxlint-disable-next-line consistent-type-specifier-style
import type { z } from "zod";

import { TaggedError } from "./tagged-error";

// the api returned a status >= 400
export class ApiError extends TaggedError("ApiError")<{
  readonly statusCode: number;
  readonly text: string;
  readonly cause?: unknown;
}> {}

// the fetch request failed
export class FetchError extends TaggedError("FetchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ParseError extends TaggedError("ParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// the input to the api was invalid
export class InputValidationError extends TaggedError("InputValidationError")<{
  readonly message: string;
  readonly zodError: z.ZodError;
}> {}

// the output from the api was invalid
export class OutputValidationError extends TaggedError(
  "OutputValidationError"
)<{
  readonly message: string;
  readonly zodError: z.ZodError;
}> {}
