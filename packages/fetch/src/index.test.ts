// oxlint-disable jest/no-conditional-in-test
import { describe, expect, test } from "bun:test";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Result } from "better-result";
import { z } from "zod/v4";

import { ValidationError } from "./errors";
import type {
  OkfetchError,
  OkfetchFetch,
  OkfetchPlugin,
  OkfetchRequestContext,
} from "./index";
import { okfetch, validateSchema } from "./index";
import { validateAllErrors, validateClientErrors } from "./presets";
import { buildRequestContext } from "./request-context";
import {
  createApiError,
  parseResponseData,
  readResponseText,
  shouldValidateErrorResponse,
} from "./response";
import { computeRetryDelay, shouldRetryError, sleep } from "./retry";
import { createParsedStream } from "./stream";
import type { OkfetchPluginInitInput } from "./types";

const createMockFetch =
  (handler: (request: Request) => Response | Promise<Response>): OkfetchFetch =>
  async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    return handler(request);
  };

const createRejectingFetch =
  (message: string): OkfetchFetch =>
  async () => {
    throw new TypeError(message);
  };

const createSSEStream = (chunks: (string | object)[]) => {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const data = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
};

const collectStreamChunks = async <T>(
  stream: ReadableStream<T>
): Promise<T[]> => {
  const chunks: T[] = [];
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
};

const getRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject");
};

const createValidatorPlugin = (schemas: {
  body?: StandardSchemaV1;
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
}): OkfetchPlugin => ({
  name: "validator",
  version: "1.0.0",
  init: async ({ options, url }) => {
    if (schemas.params) {
      const parsedParams = await validateSchema(
        schemas.params,
        options.params ?? {}
      );
      if (!parsedParams.success) {
        throw new ValidationError({
          issues: parsedParams.issues,
          type: "params",
          message: "Invalid params",
        });
      }
    }

    if (schemas.query) {
      const parsedQuery = await validateSchema(
        schemas.query,
        options.query ?? {}
      );
      if (!parsedQuery.success) {
        throw new ValidationError({
          issues: parsedQuery.issues,
          type: "query",
          message: "Invalid query",
        });
      }
    }

    if (schemas.body) {
      const parsedBody = await validateSchema(schemas.body, options.body);
      if (!parsedBody.success) {
        throw new ValidationError({
          issues: parsedBody.issues,
          type: "body",
          message: "Invalid body",
        });
      }
    }

    return { url, options };
  },
});

describe("okfetch v2 plugins", () => {
  test("supports calling okfetch with only a url", async () => {
    const originalFetch = globalThis.fetch;
    let method = "";
    let requestUrl = "";

    globalThis.fetch = createMockFetch((request) => {
      ({ method } = request);
      requestUrl = request.url;
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const result = await okfetch("https://example.com/todos");

      expect(result.isOk()).toBe(true);
      expect(method).toBe("GET");
      expect(requestUrl).toBe("https://example.com/todos");
      if (result.isOk()) {
        expect(result.value).toEqual({ ok: true });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps non-stream return types when generics are provided without options", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = createMockFetch(() =>
      Response.json({ ok: true })
    ) as typeof fetch;

    try {
      const resultPromise: Promise<
        Result<unknown, OkfetchError<{ message: string }>>
      > = okfetch<unknown, { message: string }>(
        "https://example.com/typed-no-options"
      );
      const result = await resultPromise;

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ ok: true });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("includes the response on successful calls when requested", async () => {
    const response = Response.json({ ok: true }, { status: 201 });
    const result = await okfetch("https://example.com/todos", {
      fetch: createMockFetch(() => response),
      includeResponse: true,
      outputSchema: z.object({ ok: z.boolean() }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.data).toEqual({ ok: true });
      expect(result.value.response).toBe(response);
      expect(result.value.response.status).toBe(201);
    }
  });

  test("includes the response on API errors when requested", async () => {
    const response = Response.json({ message: "Nope" }, { status: 422 });
    const result = await okfetch("https://example.com/todos", {
      fetch: createMockFetch(() => response),
      includeResponse: true,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      expect(result.error.response).toBe(response);
      expect(result.error.response?.status).toBe(422);
    }
  });

  test("executes init hooks in order and rewrites raw url and options", async () => {
    let finalInput: OkfetchPluginInitInput | undefined;
    let requestUrl = "";
    let requestHeader = "";

    const mockFetch = createMockFetch((request) => {
      requestUrl = request.url;
      requestHeader = request.headers.get("x-init") ?? "";
      return Response.json({ ok: true });
    });

    const result = await okfetch<{ ok: boolean }, unknown>("/todos/:id", {
      baseURL: "https://api.example.com",
      fetch: mockFetch,
      headers: { "x-start": "yes" },
      params: { id: 1 },
      plugins: [
        {
          name: "rewrite-url",
          version: "1.0.0",
          init: ({ options, url: rawUrl }) => ({
            options: {
              ...options,
              params: { id: 42 },
            },
            url: `${rawUrl}?from=init`,
          }),
        },
        {
          name: "capture",
          version: "1.0.0",
          init: (input) => {
            finalInput = input;
            return {
              ...input,
              options: {
                ...input.options,
                headers: {
                  ...input.options.headers,
                  "x-init": "done",
                },
              },
            };
          },
        },
      ],
    });

    expect(result.isOk()).toBe(true);
    expect(finalInput?.url).toBe("/todos/:id?from=init");
    expect(finalInput?.options.params).toEqual({ id: 42 });
    expect(requestUrl).toBe("https://api.example.com/todos/42?from=init");
    expect(requestHeader).toBe("done");
  });

  test("onRequest mutations are threaded to later plugins and fetch", async () => {
    const seen: string[] = [];
    let authHeader = "";

    const mockFetch = createMockFetch((request) => {
      authHeader = request.headers.get("authorization") ?? "";
      return Response.json({ ok: true });
    });

    const result = await okfetch<{ ok: boolean }, unknown>("/resource", {
      baseURL: "https://api.example.com",
      fetch: mockFetch,
      plugins: [
        {
          name: "first",
          version: "1.0.0",
          hooks: {
            onRequest: (context) => {
              context.headers.set("authorization", "Bearer token-123");
              seen.push(context.headers.get("authorization") ?? "");
              return context;
            },
          },
        },
        {
          name: "second",
          version: "1.0.0",
          hooks: {
            onRequest: (context) => {
              seen.push(context.headers.get("authorization") ?? "");
              return context;
            },
          },
        },
      ],
    });

    expect(result.isOk()).toBe(true);
    expect(seen).toEqual(["Bearer token-123", "Bearer token-123"]);
    expect(authHeader).toBe("Bearer token-123");
  });

  test("onResponse can replace the response used for parsing", async () => {
    const mockFetch = createMockFetch(() => Response.json({ ok: false }));

    const result = await okfetch<{ ok: boolean }, unknown>("/resource", {
      baseURL: "https://api.example.com",
      fetch: mockFetch,
      plugins: [
        {
          name: "replace-response",
          version: "1.0.0",
          hooks: {
            onResponse: () => Response.json({ ok: true }),
          },
        },
      ],
      outputSchema: z.object({
        ok: z.boolean(),
      }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.ok).toBe(true);
    }
  });

  test("onSuccess fires once after retries eventually succeed", async () => {
    let attempts = 0;
    const events: string[] = [];
    const observerPlugin: OkfetchPlugin = {
      name: "observer",
      version: "1.0.0",
      hooks: {
        onRetry: (_context, response, error, attempt) => {
          events.push(
            `retry:${attempt}:${response?.status ?? "none"}:${error._tag}`
          );
        },
        onSuccess: (_context, response, data) => {
          const parsedData = data as { ok: boolean };
          events.push(`success:${response.status}:${String(parsedData.ok)}`);
        },
      },
    };

    const mockFetch = createMockFetch(() => {
      attempts += 1;
      if (attempts < 3) {
        return new Response("boom", { status: 503, statusText: "Unavailable" });
      }

      return Response.json({ ok: true });
    });

    const result = await okfetch<{ ok: boolean }, unknown>("/resource", {
      baseURL: "https://api.example.com",
      fetch: mockFetch,
      plugins: [observerPlugin],
      retry: {
        strategy: "fixed",
        attempts: 2,
      },
    });

    expect(result.isOk()).toBe(true);
    expect(events).toEqual([
      "retry:0:503:ApiError",
      "retry:1:503:ApiError",
      "success:200:true",
    ]);
  });

  test("onFail fires once on terminal transport failure with no response", async () => {
    const events: string[] = [];
    const mockFetch = createRejectingFetch("network down");

    const result = await okfetch("https://example.com", {
      fetch: mockFetch,
      plugins: [
        {
          name: "observer",
          version: "1.0.0",
          hooks: {
            onFail: (_context, response, error) => {
              events.push(`fail:${response === undefined}:${error._tag}`);
            },
          },
        },
      ],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("network down");
    }
    expect(events).toEqual(["fail:true:FetchError"]);
  });

  test("side-effect hook failures are swallowed", async () => {
    const mockFetch = createMockFetch(() => Response.json({ ok: true }));

    const result = await okfetch<{ ok: boolean }, unknown>("/resource", {
      baseURL: "https://api.example.com",
      fetch: mockFetch,
      plugins: [
        {
          name: "noisy",
          version: "1.0.0",
          hooks: {
            onSuccess: () => {
              throw new Error("ignore me");
            },
          },
        },
      ],
    });

    expect(result.isOk()).toBe(true);
  });

  test("unexpected mutating hook failures become PluginError", async () => {
    const result = await okfetch("https://example.com", {
      plugins: [
        {
          name: "broken",
          version: "1.0.0",
          init: () => {
            throw new Error("boom");
          },
        },
      ],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "PluginError") {
      expect(result.error._tag).toBe("PluginError");
      expect(result.error.pluginName).toBe("broken");
      expect(result.error.hook).toBe("init");
    }
  });

  test("existing OkfetchError thrown by plugin is preserved", async () => {
    const parsed = z.object({ id: z.string() }).safeParse({ id: 1 });
    if (parsed.success) {
      throw new Error("Expected invalid query fixture");
    }

    const result = await okfetch("https://example.com", {
      plugins: [
        {
          name: "validator",
          version: "1.0.0",
          hooks: {
            onRequest: () => {
              throw new ValidationError({
                issues: parsed.error.issues,
                type: "query",
                message: "Nope",
              });
            },
          },
        },
      ],
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ValidationError") {
      expect(result.error._tag).toBe("ValidationError");
      expect(result.error.type).toBe("query");
    }
  });

  test("validator plugins can short-circuit before fetch", async () => {
    let calls = 0;
    const mockFetch = createMockFetch(() => {
      calls += 1;
      return Response.json({ ok: true });
    });

    const result = await okfetch("https://example.com/todos/:id", {
      body: { title: 42 },
      fetch: mockFetch,
      params: { id: "bad" },
      plugins: [
        createValidatorPlugin({
          body: z.object({ title: z.string() }),
          params: z.object({ id: z.number() }),
        }),
      ],
    });

    expect(result.isErr()).toBe(true);
    expect(calls).toBe(0);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ValidationError");
    }
  });

  test("onRetry receives undefined response on transport failures", async () => {
    const events: string[] = [];
    let calls = 0;
    const mockFetch = createMockFetch(() => {
      calls += 1;
      throw new TypeError("offline");
    });

    const result = await okfetch("https://example.com", {
      fetch: mockFetch,
      plugins: [
        {
          name: "observer",
          version: "1.0.0",
          hooks: {
            onRetry: (_context, response, error, attempt) => {
              events.push(
                `retry:${attempt}:${response === undefined}:${error._tag}`
              );
            },
          },
        },
      ],
      retry: {
        strategy: "fixed",
        attempts: 1,
      },
    });

    expect(result.isErr()).toBe(true);
    expect(calls).toBe(2);
    expect(events).toEqual(["retry:0:true:FetchError"]);
  });

  test("error schema parses and validates error data by default", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ code: "NOPE" }, { status: 400 })
    );

    const result = await okfetch<unknown, { code: string }>(
      "https://example.com/resource",
      {
        apiErrorDataSchema: z.object({ code: z.string() }),
        fetch: mockFetch,
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      expect(result.error.data).toEqual({ code: "NOPE" });
      expect(result.error.text).toContain("NOPE");
    }
  });

  test("shouldValidateError opt-out still parses error data without validating", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ code: 42 }, { status: 400 })
    );

    const result = await okfetch<unknown, { code: string }>(
      "https://example.com/resource",
      {
        apiErrorDataSchema: z.object({ code: z.string() }),
        fetch: mockFetch,
        shouldValidateError: () => false,
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      const rawData = result.error.data as unknown;
      expect(rawData).toEqual({ code: 42 });
    }
  });

  test("keeps raw parsed error data when validation fails", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ message: 42 }, { status: 400 })
    );

    const result = await okfetch<unknown, { message: string }>(
      "https://example.com/resource",
      {
        apiErrorDataSchema: z.object({ message: z.string() }),
        fetch: mockFetch,
        shouldValidateError: () => true,
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      const rawData = result.error.data as unknown;
      expect(rawData).toEqual({ message: 42 });
      expect(result.error.text).toContain("42");
    }
  });

  test("error data stays undefined without an error schema", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ code: "NOPE" }, { status: 400 })
    );

    const result = await okfetch("https://example.com/resource", {
      fetch: mockFetch,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      expect(result.error.data).toBeUndefined();
      expect(result.error.text).toContain("NOPE");
    }
  });

  test("stream returns ReadableStream of parsed chunks", async () => {
    const mockFetch = createMockFetch(
      () => new Response(createSSEStream(["hello", "world"]))
    );
    const options = {
      fetch: mockFetch,
      stream: true as const,
    };

    const result = await okfetch<string, unknown>(
      "https://example.com/stream",
      options
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual(["hello", "world"]);
    }
  });

  test("stream validates each chunk with output schema", async () => {
    const mockFetch = createMockFetch(
      () => new Response(createSSEStream([{ id: 1 }, { id: 2 }]))
    );
    const options = {
      fetch: mockFetch,
      outputSchema: z.object({
        id: z.number(),
      }),
      stream: true as const,
    };

    const result = await okfetch<{ id: number }, unknown>(
      "https://example.com/stream",
      options
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual([{ id: 1 }, { id: 2 }]);
    }
  });

  test("stream errors when a chunk does not match output schema", async () => {
    const mockFetch = createMockFetch(
      () => new Response(createSSEStream([{ id: 1 }, { id: "bad" }]))
    );
    const options = {
      fetch: mockFetch,
      outputSchema: z.object({
        id: z.number(),
      }),
      stream: true as const,
    };

    const result = await okfetch<{ id: number }, unknown>(
      "https://example.com/stream",
      options
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const reader = result.value.getReader();
      const firstChunk = await reader.read();
      expect(firstChunk.value).toEqual({ id: 1 });
      const error = await getRejection(reader.read());
      expect(error).toMatchObject({
        _tag: "ValidationError",
        type: "output",
      });
      reader.releaseLock();
    }
  });

  test("validateOutput false skips response schema validation", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ id: "unexpected-string" })
    );

    const result = await okfetch("https://example.com/resource", {
      fetch: mockFetch,
      outputSchema: z.object({
        id: z.number(),
      }),
      validateOutput: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const rawValue = result.value as unknown;
      expect(rawValue).toEqual({ id: "unexpected-string" });
    }
  });

  test("stream skips chunk schema validation when validateOutput is false", async () => {
    const mockFetch = createMockFetch(
      () => new Response(createSSEStream([{ id: 1 }, { id: "bad" }]))
    );
    const options = {
      fetch: mockFetch,
      outputSchema: z.object({
        id: z.number(),
      }),
      stream: true as const,
      validateOutput: false,
    };

    const result = await okfetch<{ id: number | string }, unknown>(
      "https://example.com/stream",
      options
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual([{ id: 1 }, { id: "bad" }]);
    }
  });

  test("manual success generic works with stream and defaults error to unknown", () => {
    const mockFetch = createMockFetch(
      () => new Response(createSSEStream(["hello", "world"]))
    );

    const resultPromise: Promise<
      Result<ReadableStream<string>, OkfetchError<unknown>>
    > = okfetch<string>("https://example.com/stream", {
      fetch: mockFetch,
      stream: true as const,
    });

    expect(resultPromise).toBeInstanceOf(Promise);
  });

  test("infers schema-based result types for stream and non-stream options", () => {
    const mockFetch = createMockFetch(() => Response.json({ id: 1 }));

    const objectResultPromise: Promise<
      Result<{ id: number }, OkfetchError<unknown>>
    > = okfetch("https://example.com/object", {
      fetch: mockFetch,
      outputSchema: z.object({
        id: z.number(),
      }),
    });

    const streamResultPromise: Promise<
      Result<ReadableStream<{ id: number }>, OkfetchError<unknown>>
    > = okfetch("https://example.com/stream", {
      fetch: mockFetch,
      outputSchema: z.object({
        id: z.number(),
      }),
      stream: true as const,
    });

    expect(objectResultPromise).toBeInstanceOf(Promise);
    expect(streamResultPromise).toBeInstanceOf(Promise);
  });

  test("supports hand-rolled Standard Schema validators", async () => {
    const standardSchema: StandardSchemaV1 = {
      "~standard": {
        validate: (value: unknown) => {
          if (
            typeof value === "object" &&
            value !== null &&
            "id" in value &&
            typeof value.id === "number"
          ) {
            return { value: { id: value.id } };
          }

          return {
            issues: [{ message: "id must be a number", path: ["id"] }],
          };
        },
        vendor: "custom",
        version: 1,
      },
    };

    const success = await okfetch("https://example.com/resource", {
      fetch: createMockFetch(() => Response.json({ id: 1 })),
      outputSchema: standardSchema,
    });

    expect(success.isOk()).toBe(true);
    if (success.isOk()) {
      expect(success.value).toEqual({ id: 1 });
    }

    const failure = await okfetch("https://example.com/resource", {
      fetch: createMockFetch(() => Response.json({ id: "bad" })),
      outputSchema: standardSchema,
    });

    expect(failure.isErr()).toBe(true);
    if (failure.isErr() && failure.error._tag === "ValidationError") {
      expect(failure.error.issues).toEqual([
        { message: "id must be a number", path: ["id"] },
      ]);
    }
  });
});

describe("request context", () => {
  test("builds urls, auth headers, and json bodies", () => {
    const context = buildRequestContext("/todos/:id", {
      auth: {
        password: "secret",
        type: "basic",
        username: "alice",
      },
      baseURL: "https://api.example.com/v1",
      body: {
        done: false,
        title: "Ship tests",
      },
      headers: {
        "x-trace-id": "trace-123",
      },
      params: {
        id: 42,
      },
      query: {
        filter: "open",
        tags: ["backend", "urgent"],
      },
    });

    expect(context.method).toBe("POST");
    expect(context.url.toString()).toBe(
      "https://api.example.com/v1/todos/42?filter=open&tags=backend&tags=urgent"
    );
    expect(context.headers.get("authorization")).toBe("Basic YWxpY2U6c2VjcmV0");
    expect(context.headers.get("content-type")).toBe("application/json");
    expect(context.headers.get("x-trace-id")).toBe("trace-123");
    expect(context.body).toBe('{"done":false,"title":"Ship tests"}');
  });

  test("supports custom auth, form bodies, and bodyless methods", () => {
    const formContext = buildRequestContext("https://example.com/form", {
      auth: {
        prefix: "Token",
        type: "custom",
        value: "abc123",
      },
      body: {
        tags: ["a", "b"],
        title: "hello",
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "PUT",
    });

    expect(formContext.headers.get("authorization")).toBe("Token abc123");
    expect(formContext.body).toBe("tags=a&tags=b&title=hello");

    const headContext = buildRequestContext("https://example.com/head", {
      auth: {
        token: "token-123",
        type: "bearer",
      },
      body: {
        ignored: true,
      },
      method: "HEAD",
    });

    expect(headContext.headers.get("authorization")).toBe("Bearer token-123");
    expect(headContext.body).toBeUndefined();
  });

  test("preserves direct body values", () => {
    const directBody = new Blob(["hello"]);
    const context = buildRequestContext("https://example.com/blob", {
      body: directBody,
      method: "PATCH",
    });

    expect(context.body).toBe(directBody);
  });

  test("does not override an explicit content type for object bodies", () => {
    const context = buildRequestContext("https://example.com/custom", {
      body: { title: "hello" },
      headers: {
        "Content-Type": "application/merge-patch+json",
      },
      method: "PATCH",
    });

    expect(context.headers.get("content-type")).toBe(
      "application/merge-patch+json"
    );
    expect(context.body).toBe('{"title":"hello"}');
  });

  test("keeps valid falsey JSON bodies", () => {
    const zeroContext = buildRequestContext("https://example.com/zero", {
      body: 0,
    });
    const nullContext = buildRequestContext("https://example.com/null", {
      body: null,
      method: "POST",
    });
    const emptyStringContext = buildRequestContext(
      "https://example.com/empty-string",
      {
        body: "",
        method: "POST",
      }
    );

    expect(zeroContext.method).toBe("POST");
    expect(zeroContext.headers.get("content-type")).toBe("application/json");
    expect(zeroContext.body).toBe("0");

    expect(nullContext.headers.get("content-type")).toBe("application/json");
    expect(nullContext.body).toBe("null");

    expect(emptyStringContext.headers.get("content-type")).toBeNull();
    expect(emptyStringContext.body).toBe("");
  });

  test("omits undefined query values from the url", () => {
    const context = buildRequestContext("https://example.com/browse", {
      query: {
        cursor: undefined,
        limit: 3,
      },
    });

    expect(context.url.toString()).toBe("https://example.com/browse?limit=3");
  });

  test("omits undefined items from array query values", () => {
    const context = buildRequestContext("https://example.com/search", {
      query: {
        limit: 2,
        tags: ["backend", undefined, "urgent"],
      },
    });

    expect(context.url.toString()).toBe(
      "https://example.com/search?limit=2&tags=backend&tags=urgent"
    );
  });

  test("does not render undefined into the url for missing path params", () => {
    const context = buildRequestContext("/todos/:id", {
      baseURL: "https://api.example.com",
      params: {
        id: undefined,
      },
      query: {
        filter: "open",
      },
    });

    expect(context.url.pathname).toBe("/todos/:id");
    expect(context.url.toString()).not.toContain("undefined");
  });

  test("omits undefined values from form-urlencoded bodies", () => {
    const context = buildRequestContext("https://example.com/form", {
      body: {
        cursor: undefined,
        tags: ["a", undefined, "b"],
        title: "hello",
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "PUT",
    });

    expect(context.body).toBe("tags=a&tags=b&title=hello");
  });

  test("serializes null values to the literal string null", () => {
    // Unlike undefined, null is intentionally not treated as absent.
    const cursor = null as unknown as string;

    const queryContext = buildRequestContext("https://example.com/browse", {
      query: {
        cursor,
        limit: 3,
      },
    });

    expect(queryContext.url.toString()).toBe(
      "https://example.com/browse?cursor=null&limit=3"
    );

    const formContext = buildRequestContext("https://example.com/form", {
      body: {
        cursor,
        title: "hello",
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    expect(formContext.body).toBe("cursor=null&title=hello");
  });
});

describe("response helpers", () => {
  test("parses and validates success payloads", async () => {
    const parsed = await parseResponseData<{ id: number }>('{"id":1}', {
      outputSchema: z.object({
        id: z.number(),
      }),
    });

    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value).toEqual({ id: 1 });
    }
  });

  test("returns parse and validation errors for invalid success payloads", async () => {
    const invalidJson = await parseResponseData("not-json", {});
    expect(invalidJson.isErr()).toBe(true);
    if (invalidJson.isErr()) {
      expect(invalidJson.error._tag).toBe("ParseError");
    }

    const invalidShape = await parseResponseData('{"id":"bad"}', {
      outputSchema: z.object({
        id: z.number(),
      }),
    });
    expect(invalidShape.isErr()).toBe(true);
    if (invalidShape.isErr()) {
      expect(invalidShape.error._tag).toBe("ValidationError");
    }
  });

  test("reads response text failures into ParseError", async () => {
    const brokenResponse = {
      text: () => {
        throw new Error("cannot read");
      },
    } as unknown as Response;

    const result = await readResponseText(brokenResponse);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ParseError");
    }
  });

  test("creates typed api errors only when configured", async () => {
    expect(
      shouldValidateErrorResponse(
        {
          apiErrorDataSchema: z.object({ code: z.string() }),
          shouldValidateError: validateAllErrors,
        },
        500
      )
    ).toBe(true);

    expect(
      shouldValidateErrorResponse(
        {
          apiErrorDataSchema: z.object({ code: z.string() }),
        },
        500
      )
    ).toBe(true);

    expect(shouldValidateErrorResponse({}, 500)).toBe(false);

    expect(
      shouldValidateErrorResponse(
        {
          apiErrorDataSchema: z.object({ code: z.string() }),
          shouldValidateError: validateClientErrors,
        },
        500
      )
    ).toBe(false);

    const typed = await createApiError<{ code: string }>(
      new Response('{"code":"BAD"}', {
        status: 400,
        statusText: "Bad Request",
      }),
      '{"code":"BAD"}',
      {
        apiErrorDataSchema: z.object({ code: z.string() }),
        shouldValidateError: validateClientErrors,
      }
    );

    expect(typed.data).toEqual({ code: "BAD" });

    const untyped = await createApiError(
      new Response("{bad json", {
        status: 400,
        statusText: "Bad Request",
      }),
      "{bad json",
      {
        apiErrorDataSchema: z.object({ code: z.string() }),
        shouldValidateError: validateClientErrors,
      }
    );

    expect(untyped.data).toBeUndefined();
    expect(untyped.text).toBe("{bad json");
  });
});

describe("retry helpers", () => {
  test("computes fixed, linear, and exponential delays", () => {
    expect(computeRetryDelay({}, 0)).toBe(0);

    expect(
      computeRetryDelay(
        {
          retry: {
            attempts: 2,
            delay: 25,
            strategy: "fixed",
          },
        },
        0
      )
    ).toBe(25);

    expect(
      computeRetryDelay(
        {
          retry: {
            attempts: 2,
            initialDelay: 100,
            maxDelay: 250,
            step: 80,
            strategy: "linear",
          },
        },
        3
      )
    ).toBe(250);

    expect(
      computeRetryDelay(
        {
          retry: {
            attempts: 2,
            factor: 3,
            initialDelay: 50,
            maxDelay: 400,
            strategy: "exponential",
          },
        },
        2
      )
    ).toBe(400);
  });

  test("applies default retry rules, limits, and custom overrides", async () => {
    expect(
      shouldRetryError(
        await createApiError(
          new Response("server down", {
            status: 503,
            statusText: "Unavailable",
          }),
          "server down",
          {}
        ),
        {}
      )
    ).toBe(false);

    expect(
      shouldRetryError(
        await createApiError(
          new Response("server down", {
            status: 503,
            statusText: "Unavailable",
          }),
          "server down",
          {}
        ),
        {
          retry: {
            attempts: 2,
            strategy: "fixed",
          },
        }
      )
    ).toBe(true);

    expect(
      shouldRetryError(
        await createApiError(
          new Response("bad request", {
            status: 400,
            statusText: "Bad Request",
          }),
          "bad request",
          {}
        ),
        {
          retry: {
            attempts: 2,
            strategy: "fixed",
          },
        }
      )
    ).toBe(false);

    expect(
      shouldRetryError(
        await createApiError(
          new Response("server down", {
            status: 503,
            statusText: "Unavailable",
          }),
          "server down",
          {}
        ),
        {
          _retryAttempt: 2,
          retry: {
            attempts: 2,
            strategy: "fixed",
          },
        }
      )
    ).toBe(false);

    expect(
      shouldRetryError(
        await createApiError(
          new Response("bad request", {
            status: 400,
            statusText: "Bad Request",
          }),
          "bad request",
          {}
        ),
        {
          retry: {
            attempts: 1,
            shouldRetry: () => true,
            strategy: "fixed",
          },
        }
      )
    ).toBe(true);
  });

  test("sleep resolves asynchronously", async () => {
    expect(await sleep(0)).toBeUndefined();
  });
});

describe("stream helpers", () => {
  test("parses buffered SSE chunks and ignores non-data lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ping\n"));
        controller.enqueue(encoder.encode('data: {"id":'));
        controller.enqueue(encoder.encode("1}\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      },
    });

    const parsed = createParsedStream<{ id: number }>(
      stream,
      z.object({
        id: z.number(),
      })
    );

    expect(await collectStreamChunks(parsed)).toEqual([{ id: 1 }]);
  });

  test("surfaces parse errors for invalid json stream chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {bad json}\n"));
        controller.close();
      },
    });

    const parsed = createParsedStream<{ id: number }>(
      stream,
      z.object({
        id: z.number(),
      })
    );
    const reader = parsed.getReader();

    const error = await getRejection(reader.read());
    expect(error).toMatchObject({
      _tag: "ParseError",
    });
    reader.releaseLock();
  });

  test("flushes trailing buffered data at end of stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"bad"}'));
        controller.close();
      },
    });

    const parsed = createParsedStream<{ id: number }>(
      stream,
      z.object({
        id: z.number(),
      })
    );
    const reader = parsed.getReader();

    const error = await getRejection(reader.read());
    expect(error).toMatchObject({
      _tag: "ValidationError",
      type: "output",
    });
    reader.releaseLock();
  });

  test("cancels the underlying reader when the parsed stream is cancelled", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(encoder.encode("data: hello\n"));
      },
    });

    const parsed = createParsedStream<string>(stream);
    const reader = parsed.getReader();

    await reader.cancel();
    reader.releaseLock();
    expect(cancelled).toBe(true);
  });
});

describe("okfetch edge cases", () => {
  test("does not serialize undefined query values into the request url", async () => {
    let requestUrl = "";
    const mockFetch = createMockFetch((request) => {
      requestUrl = request.url;
      return Response.json({ ok: true });
    });

    // Simulates a conditional spread producing an explicit undefined.
    const cursor = undefined;

    const result = await okfetch("https://example.com/browse", {
      fetch: mockFetch,
      query: {
        cursor,
        limit: 3,
      },
    });

    expect(result.isOk()).toBe(true);
    expect(requestUrl).toBe("https://example.com/browse?limit=3");
  });

  test("wraps onRequest and onResponse hook failures as PluginError", async () => {
    const onRequestResult = await okfetch("https://example.com", {
      plugins: [
        {
          name: "broken-request",
          version: "1.0.0",
          hooks: {
            onRequest: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });

    expect(onRequestResult.isErr()).toBe(true);
    if (onRequestResult.isErr()) {
      expect(onRequestResult.error).toMatchObject({
        _tag: "PluginError",
        hook: "onRequest",
        pluginName: "broken-request",
      });
    }

    const onResponseResult = await okfetch("https://example.com", {
      fetch: createMockFetch(() => Response.json({ ok: true })),
      plugins: [
        {
          name: "broken-response",
          version: "1.0.0",
          hooks: {
            onResponse: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });

    expect(onResponseResult.isErr()).toBe(true);
    if (onResponseResult.isErr()) {
      expect(onResponseResult.error).toMatchObject({
        _tag: "PluginError",
        hook: "onResponse",
        pluginName: "broken-response",
      });
    }
  });

  test("onFail receives the context produced before a later onRequest hook throws", async () => {
    let failContext: OkfetchRequestContext | undefined;
    const stateful: OkfetchPlugin = {
      name: "stateful",
      version: "1.0.0",
      hooks: {
        onRequest: (context) => {
          const headers = new Headers(context.headers);
          headers.set("x-stateful", "attached");
          return { ...context, headers };
        },
        onFail: (context) => {
          failContext = context;
        },
      },
    };

    const result = await okfetch("https://example.com", {
      fetch: createMockFetch(() => Response.json({ ok: true })),
      plugins: [
        stateful,
        {
          name: "broken-request",
          version: "1.0.0",
          hooks: {
            onRequest: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });

    expect(result.isErr()).toBe(true);
    expect(failContext?.headers.get("x-stateful")).toBe("attached");
  });

  test("onFail fires when mutating hooks or the body read fail", async () => {
    const events: string[] = [];
    const observer: OkfetchPlugin = {
      name: "observer",
      version: "1.0.0",
      hooks: {
        onFail: (_context, response, error) => {
          events.push(`fail:${response?.status ?? "none"}:${error._tag}`);
        },
      },
    };

    await okfetch("https://example.com", {
      fetch: createMockFetch(() => Response.json({ ok: true })),
      plugins: [
        observer,
        {
          name: "broken-request",
          version: "1.0.0",
          hooks: {
            onRequest: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });

    await okfetch("https://example.com", {
      fetch: createMockFetch(() => Response.json({ ok: true })),
      plugins: [
        observer,
        {
          name: "broken-response",
          version: "1.0.0",
          hooks: {
            onResponse: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });

    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("broken body"));
      },
    });
    const bodyResult = await okfetch("https://example.com", {
      fetch: createMockFetch(() => new Response(brokenBody, { status: 200 })),
      plugins: [observer],
    });

    expect(bodyResult.isErr()).toBe(true);
    expect(events).toEqual([
      "fail:none:PluginError",
      "fail:200:PluginError",
      "fail:200:ParseError",
    ]);
  });

  test("returns timeout and stream body parse failures", async () => {
    const timeoutResult = await okfetch("https://example.com/timeout", {
      fetch: createMockFetch(
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
      ),
      timeout: 10,
    });

    expect(timeoutResult.isErr()).toBe(true);
    if (timeoutResult.isErr()) {
      expect(timeoutResult.error).toMatchObject({
        _tag: "TimeoutError",
        timout: 10,
      });
    }

    const nullBodyResult = await okfetch("https://example.com/stream", {
      fetch: createMockFetch(() => new Response(null, { status: 200 })),
      stream: true,
    });

    expect(nullBodyResult.isErr()).toBe(true);
    if (nullBodyResult.isErr()) {
      expect(nullBodyResult.error).toMatchObject({
        _tag: "ParseError",
        message: "Response body is null",
      });
    }
  });

  test("returns parse failures for unreadable or invalid success bodies", async () => {
    const unreadableResponse = {
      body: undefined,
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => {
        throw new Error("cannot read");
      },
    } as unknown as Response;

    const unreadableResult = await okfetch("https://example.com/unreadable", {
      fetch: createMockFetch(() => unreadableResponse),
    });

    expect(unreadableResult.isErr()).toBe(true);
    if (unreadableResult.isErr()) {
      expect(unreadableResult.error._tag).toBe("ParseError");
    }

    const invalidJsonResult = await okfetch(
      "https://example.com/invalid-json",
      {
        fetch: createMockFetch(() => new Response("not-json")),
      }
    );

    expect(invalidJsonResult.isErr()).toBe(true);
    if (invalidJsonResult.isErr()) {
      expect(invalidJsonResult.error._tag).toBe("ParseError");
    }
  });
});
