import { ApiService, createApi, createEndpoints } from "@okfetch/api";
import type { OkfetchError, OkfetchResponse } from "@okfetch/fetch";
import type { Result } from "better-result";
import { expect, test } from "tstyche";
import { z } from "zod/v4";

const endpoints = createEndpoints({
  health: {
    method: "GET",
    output: z.object({ ok: z.boolean() }),
    path: "/health",
  },
  users: {
    create: {
      body: z.object({ name: z.string() }),
      error: z.object({ code: z.string() }),
      method: "POST",
      output: z.object({ id: z.number(), name: z.string() }),
      path: "/users",
      query: z.object({ notify: z.boolean().optional() }),
    },
    events: {
      method: "GET",
      output: z.object({ id: z.number() }),
      path: "/users/events",
      stream: true,
    },
  },
});

const api = createApi({
  baseURL: "https://example.com",
  endpoints,
});

test("creates nested methods with schema-derived inputs", () => {
  expect(api.users.create).type.toBeCallableWith({
    body: { name: "Ada" },
    query: {},
  });
  expect(api.users.create).type.toBeCallableWith({
    body: { name: "Ada" },
    query: { notify: true },
  });

  expect(api.users.create).type.not.toBeCallableWith();
  expect(api.users.create).type.not.toBeCallableWith({
    body: { name: 42 },
    query: {},
  });
  expect(api.users.create).type.not.toBeCallableWith({
    body: { name: "Ada" },
  });
});

test("infers endpoint output and error types", () => {
  expect(api.users.create({ body: { name: "Ada" }, query: {} })).type.toBe<
    Promise<
      Result<{ id: number; name: string }, OkfetchError<{ code: string }>>
    >
  >();
});

test("includes a typed response through per-call overrides", () => {
  expect(
    api.users.create(
      { body: { name: "Ada" }, query: {} },
      { includeResponse: true }
    )
  ).type.toBe<
    Promise<
      Result<
        OkfetchResponse<{ id: number; name: string }>,
        OkfetchError<{ code: string }>
      >
    >
  >();

  expect(api.health({ includeResponse: true })).type.toBe<
    Promise<Result<OkfetchResponse<{ ok: boolean }>, OkfetchError<unknown>>>
  >();
  expect(api.health({})).type.toBe<
    Promise<Result<{ ok: boolean }, OkfetchError<unknown>>>
  >();

  const requestOverrides: Parameters<typeof api.health>[0] = {
    includeResponse: Math.random() > 0.5,
  };
  expect(api.health(requestOverrides)).type.toBe<
    Promise<
      Result<
        { ok: boolean } | OkfetchResponse<{ ok: boolean }>,
        OkfetchError<unknown>
      >
    >
  >();
});

test("uses global errors as a fallback to endpoint errors", () => {
  const apiWithGlobalError = createApi({
    baseURL: "https://example.com",
    endpoints,
    errorSchema: z.object({ message: z.string() }),
  });

  expect(apiWithGlobalError.health()).type.toBe<
    Promise<Result<{ ok: boolean }, OkfetchError<{ message: string }>>>
  >();
  expect(
    apiWithGlobalError.users.create({ body: { name: "Ada" }, query: {} })
  ).type.toBe<
    Promise<
      Result<{ id: number; name: string }, OkfetchError<{ code: string }>>
    >
  >();
});

test("uses schema inputs for requests and outputs for responses", () => {
  const transformedApi = createApi({
    baseURL: "https://example.com",
    endpoints: createEndpoints({
      createUser: {
        body: z.object({
          name: z.string().transform((name) => name.length),
        }),
        method: "POST",
        output: z.object({
          id: z.string().transform(Number),
        }),
        path: "/users",
      },
    }),
  });

  expect(transformedApi.createUser).type.toBeCallableWith({
    body: { name: "Ada" },
  });
  expect(transformedApi.createUser).type.not.toBeCallableWith({
    body: { name: 3 },
  });
  expect(transformedApi.createUser({ body: { name: "Ada" } })).type.toBe<
    Promise<Result<{ id: number }, OkfetchError<unknown>>>
  >();
});

test("prevents endpoint-owned options from being overridden", () => {
  expect(api.health).type.not.toBeCallableWith({ method: "POST" });
  expect(api.health).type.not.toBeCallableWith({ body: { name: "Ada" } });
  expect(api.health).type.not.toBeCallableWith({ outputSchema: z.string() });
  expect(api.health).type.not.toBeCallableWith({ stream: true });

  expect(api.users.create).type.not.toBeCallableWith(
    { body: { name: "Ada" }, query: {} },
    { method: "GET" }
  );
});

test("preserves endpoint types through ApiService", () => {
  class UserService extends ApiService(
    endpoints,
    z.object({ message: z.string() })
  ) {
    constructor() {
      super({ baseURL: "https://example.com" });
    }
  }

  const service = new UserService();

  expect(service.api.users.create).type.toBeCallableWith({
    body: { name: "Ada" },
    query: {},
  });
  expect(service.api.health()).type.toBe<
    Promise<Result<{ ok: boolean }, OkfetchError<{ message: string }>>>
  >();
  expect(
    service.api.users.create({ body: { name: "Ada" }, query: {} })
  ).type.toBe<
    Promise<
      Result<{ id: number; name: string }, OkfetchError<{ code: string }>>
    >
  >();
});

test("keeps zero-input and streaming endpoints ergonomic", () => {
  expect(api.health).type.toBeCallableWith();
  expect(api.health()).type.toBe<
    Promise<Result<{ ok: boolean }, OkfetchError<unknown>>>
  >();
  expect(api.users.events()).type.toBe<
    Promise<Result<ReadableStream<{ id: number }>, OkfetchError<unknown>>>
  >();
});
