import type {
  ApiError,
  FetchError,
  OkfetchError,
  OkfetchPlugin,
  OkfetchResponse,
  TimeoutError,
} from "@okfetch/fetch";
import { okfetch } from "@okfetch/fetch";
import type { Result } from "better-result";
import { expect, test } from "tstyche";
import { z } from "zod/v4";

const userSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const errorSchema = z.object({
  code: z.string(),
});

test("infers output and API error schemas", () => {
  const result = okfetch("https://example.com/users/1", {
    apiErrorDataSchema: errorSchema,
    outputSchema: userSchema,
  });

  expect(result).type.toBe<
    Promise<
      Result<{ id: number; name: string }, OkfetchError<{ code: string }>>
    >
  >();
});

test("infers a typed stream from the output schema", () => {
  const result = okfetch("https://example.com/events", {
    outputSchema: userSchema,
    stream: true,
  });

  expect(result).type.toBe<
    Promise<
      Result<
        ReadableStream<{ id: number; name: string }>,
        OkfetchError<unknown>
      >
    >
  >();
});

test("defaults unvalidated responses to unknown", () => {
  expect(okfetch("https://example.com/health")).type.toBe<
    Promise<Result<unknown, OkfetchError<unknown>>>
  >();
});

test("includes a typed response only when requested", () => {
  expect(
    okfetch("https://example.com/users/1", {
      includeResponse: true,
      outputSchema: userSchema,
    })
  ).type.toBe<
    Promise<
      Result<
        OkfetchResponse<{ id: number; name: string }>,
        OkfetchError<unknown>
      >
    >
  >();

  const includeResponse: boolean = Math.random() > 0.5;
  expect(
    okfetch("https://example.com/users/1", {
      includeResponse,
      outputSchema: userSchema,
    })
  ).type.toBe<
    Promise<
      Result<
        | { id: number; name: string }
        | OkfetchResponse<{ id: number; name: string }>,
        OkfetchError<unknown>
      >
    >
  >();
});

test("supports explicit response and error generics", () => {
  expect(
    okfetch<{ id: number }, { code: string }>("https://example.com")
  ).type.toBe<
    Promise<Result<{ id: number }, OkfetchError<{ code: string }>>>
  >();
  expect(
    okfetch<{ id: number }, { code: string }>("https://example.com/events", {
      stream: true,
    })
  ).type.toBe<
    Promise<
      Result<ReadableStream<{ id: number }>, OkfetchError<{ code: string }>>
    >
  >();
});

test("types plugin lifecycle hooks", () => {
  type User = { id: number };
  type ApiFailure = { code: string };

  const plugin: OkfetchPlugin<User, ApiFailure> = {
    name: "typed-plugin",
    version: "1.0.0",
    hooks: {
      onSuccess: (_context, response, data) => {
        expect(response).type.toBe<Response>();
        expect(data).type.toBe<User>();
      },
      onFail: (_context, response, error) => {
        expect(response).type.toBe<Response | undefined>();
        expect(error).type.toBe<OkfetchError<ApiFailure>>();
      },
      onRetry: (_context, response, error, attempt) => {
        expect(response).type.toBe<Response | undefined>();
        expect(error).type.toBe<
          FetchError | ApiError<unknown> | TimeoutError
        >();
        expect(attempt).type.toBe<number>();
      },
    },
  };

  expect(plugin).type.toBeAssignableTo<OkfetchPlugin<User, ApiFailure>>();
});
