// oxlint-disable no-inline-comments
// oxlint-disable no-conditional-in-test
// oxlint-disable max-statements
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  ApiError,
  FetchError,
  InputValidationError,
  OutputValidationError,
  ParseError,
} from "./errors";
import { createApi, createEndpoints } from "./index";
import {
  collectStreamChunks,
  createMockServer,
  createSSEStream,
} from "./test-helpers";

// Basic API Client Tests (5 tests)
describe("Basic API Client", () => {
  test("should create API client", () => {
    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/:id",
      },
    });

    const api = createApi({
      baseUrl: "https://api.example.com",
      endpoints,
    });

    expect(api).toBeDefined();
    expect(api.getTodo).toBeDefined();
    expect(typeof api.getTodo).toBe("function");
  });

  test("should make GET request", async () => {
    const { url } = createMockServer(() =>
      Response.json({ id: 1, title: "Test" })
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.getTodo();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe(1);
      expect(result.value.title).toBe("Test");
    }
  });
});

describe("Authentication", () => {
  test("should add Bearer token header", async () => {
    let authHeader = "";

    const { url } = createMockServer((req) => {
      authHeader = req.headers.get("Authorization") || "";
      return Response.json({ success: true });
    });

    const endpoints = createEndpoints({
      getProfile: {
        method: "GET",
        output: z.object({ success: z.boolean() }),
        path: "/profile",
      },
    });

    const api = createApi({
      auth: { token: "test-token-123", type: "bearer" },
      baseUrl: url,
      endpoints,
    });

    await api.getProfile();
    expect(authHeader).toBe("Bearer test-token-123");
  });

  test("should add Basic auth header", async () => {
    let authHeader = "";

    const { url } = createMockServer((req) => {
      authHeader = req.headers.get("Authorization") || "";
      return Response.json({ success: true });
    });

    const endpoints = createEndpoints({
      getProfile: {
        method: "GET",
        output: z.object({ success: z.boolean() }),
        path: "/profile",
      },
    });

    const api = createApi({
      auth: { password: "pass", type: "basic", username: "user" },
      baseUrl: url,
      endpoints,
    });

    await api.getProfile();
    expect(authHeader).toBe(`Basic ${btoa("user:pass")}`);
  });
});

// Validation Tests (3 tests)
describe("Validation", () => {
  test("should validate input when enabled", async () => {
    const { url } = createMockServer(() =>
      Response.json({ id: 1, title: "Test" })
    );

    const endpoints = createEndpoints({
      createTodo: {
        input: z.object({ title: z.string() }),
        method: "POST",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos",
      },
    });

    const api = createApi({ baseUrl: url, endpoints, validateInput: true });

    // Valid input should work
    const validResult = await api.createTodo({ input: { title: "Test" } });
    expect(validResult.isOk()).toBe(true);

    // Invalid input should fail
    const invalidResult = await api.createTodo({
      input: { title: 123 } as unknown as { title: string },
    });
    expect(invalidResult.isErr()).toBe(true);
    if (invalidResult.isErr()) {
      expect(invalidResult.error._tag).toBe("InputValidationError");
    }
  });

  test("should validate output when enabled", async () => {
    const { url } = createMockServer(() =>
      Response.json({ id: "invalid", title: "Test" })
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints, validateOutput: true });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("OutputValidationError");
    }
  });

  test("should skip validation when disabled", async () => {
    const { url } = createMockServer(() =>
      Response.json({ id: "invalid", title: "Test" })
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints, validateOutput: false });
    const result = await api.getTodo();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // When validation is disabled, we get the raw value
      expect((result.value as { id: unknown }).id).toBe("invalid");
    }
  });
});

// Error Handling Tests (3 tests)
describe("Error Handling", () => {
  test("should return ApiError on 4xx/5xx", async () => {
    const { url } = createMockServer(
      () => new Response("Not Found", { status: 404 })
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      expect((result.error as ApiError).statusCode).toBe(404);
    }
  });

  test("should return FetchError on network failure", async () => {
    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number() }),
        path: "/todos/1",
      },
    });

    const api = createApi({
      baseUrl: "http://localhost:1", // Invalid port
      endpoints,
    });

    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("FetchError");
    }
  });

  test("should return InputValidationError on invalid input", async () => {
    const { url } = createMockServer(() => Response.json({ id: 1 }));

    const endpoints = createEndpoints({
      createTodo: {
        input: z.object({ title: z.string().min(3) }),
        method: "POST",
        output: z.object({ id: z.number() }),
        path: "/todos",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.createTodo({ input: { title: "ab" } });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("InputValidationError");
    }
  });
});

// Streaming - Basic Tests (8 tests)
describe("Streaming - Basic", () => {
  test("should parse SSE format", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream(["hello", "world"]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual(["hello", "world"]);
    }
  });

  test("should return ReadableStream<string> without schema", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream(["test"]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeInstanceOf(ReadableStream);
      const chunks = await collectStreamChunks(result.value);
      expect(chunks[0]).toBe("test");
      expect(typeof chunks[0]).toBe("string");
    }
  });

  test("should handle multiple chunks", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream(["one", "two", "three", "four"]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(4);
      expect(chunks).toEqual(["one", "two", "three", "four"]);
    }
  });

  test("should skip empty data lines", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: hello\n\n"));
          controller.enqueue(encoder.encode("data: \n\n")); // Empty
          controller.enqueue(encoder.encode("data: world\n\n"));
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual(["hello", "world"]);
    }
  });

  test("should skip [DONE] markers", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: message1\n\n"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.enqueue(encoder.encode("data: message2\n\n"));
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual(["message1", "message2"]);
    }
  });

  test("should buffer incomplete lines", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Send partial line
          controller.enqueue(encoder.encode("data: hel"));
          controller.enqueue(encoder.encode("lo\n\n"));
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual(["hello"]);
    }
  });

  // oxlint-disable-next-line max-statements
  test("should handle stream cancellation", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream(["one", "two", "three"]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const reader = result.value.getReader();
      const { value } = await reader.read();
      expect(value).toBe("one");

      // Cancel the stream
      await reader.cancel();

      // Stream should be done
      const { done } = await reader.read();
      expect(done).toBe(true);
    }
  });

  test("should return ApiError before streaming on error", async () => {
    const { url } = createMockServer(
      () => new Response("Not Found", { status: 404 })
    );

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      expect((result.error as ApiError).statusCode).toBe(404);
    }
  });
});

// Streaming - Typed with Schema Tests (10 tests)
describe("Streaming - Typed with Schema", () => {
  test("should return ReadableStream<T> with schema", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream([{ id: 1, msg: "hello" }]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ id: z.number(), msg: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.id).toBe(1);
      expect(chunks[0]?.msg).toBe("hello");
    }
  });

  test("should parse JSON chunks with object schema", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream([
        { id: 1, text: "first" },
        { id: 2, text: "second" },
      ]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ id: z.number(), text: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.id).toBe(1);
      expect(chunks[1]?.id).toBe(2);
    }
  });

  test("should validate chunks when validateOutput=true", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":1,"msg":"valid"}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"id":"invalid","msg":"bad"}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"id":2,"msg":"valid"}\n\n')
          );
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ id: z.number(), msg: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints, validateOutput: true });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      // Invalid chunk should be skipped
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.id).toBe(1);
      expect(chunks[1]?.id).toBe(2);
    }
  });

  test("should skip validation when validateOutput=false", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":"not-a-number","msg":"test"}\n\n')
          );
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ id: z.number(), msg: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints, validateOutput: false });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(1);
      // Should receive unvalidated data
      expect((chunks[0] as { id: unknown }).id).toBe("not-a-number");
    }
  });

  test("should skip invalid JSON chunks with warning", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":1,"msg":"valid"}\n\n')
          );
          controller.enqueue(encoder.encode("data: {invalid json}\n\n"));
          controller.enqueue(
            encoder.encode('data: {"id":2,"msg":"valid"}\n\n')
          );
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ id: z.number(), msg: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      // Invalid JSON chunk should be skipped
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.id).toBe(1);
      expect(chunks[1]?.id).toBe(2);
    }
  });

  test("should skip invalid validation chunks with warning", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":1,"msg":"valid"}\n\n')
          );
          controller.enqueue(encoder.encode('data: {"id":2}\n\n')); // Missing msg
          controller.enqueue(
            encoder.encode('data: {"id":3,"msg":"valid"}\n\n')
          );
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ id: z.number(), msg: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints, validateOutput: true });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      // Invalid chunk should be skipped
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.id).toBe(1);
      expect(chunks[1]?.id).toBe(3);
    }
  });

  test("should continue stream after invalid chunk", async () => {
    const { url } = createMockServer(() => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"valid":true}\n\n'));
          controller.enqueue(encoder.encode("data: invalid\n\n"));
          controller.enqueue(encoder.encode('data: {"valid":true}\n\n'));
          controller.enqueue(encoder.encode("data: {bad json\n\n"));
          controller.enqueue(encoder.encode('data: {"valid":true}\n\n'));
          controller.close();
        },
      });
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({ valid: z.boolean() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      // Should get 3 valid chunks, 2 invalid skipped
      expect(chunks).toHaveLength(3);
      expect(chunks.every((c) => c?.valid === true)).toBe(true);
    }
  });

  test("should handle z.string() schema", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream(['"hello"', '"world"']);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.string(),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual(["hello", "world"]);
    }
  });

  test("should handle z.number() schema", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream(["42", "100", "999"]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.number(),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual([42, 100, 999]);
    }
  });

  test("should handle nested schemas", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream([
        { timestamp: 123, user: { id: 1, name: "Alice" } },
        { timestamp: 456, user: { id: 2, name: "Bob" } },
      ]);
      return new Response(stream);
    });

    const endpoints = createEndpoints({
      stream: {
        method: "GET",
        output: z.object({
          timestamp: z.number(),
          user: z.object({ id: z.number(), name: z.string() }),
        }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.stream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.user.name).toBe("Alice");
      expect(chunks[1]?.user.name).toBe("Bob");
    }
  });
});

// Integration Tests (3 tests)
describe("Integration", () => {
  test("should combine validation and streaming", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream([
        { id: 1, status: "ok" },
        { id: 2, status: "ok" },
      ]);
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const endpoints = createEndpoints({
      processStream: {
        method: "POST",
        output: z.object({ id: z.number(), status: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({
      baseUrl: url,
      endpoints,
      validateOutput: true,
    });

    const result = await api.processStream();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.status).toBe("ok");
    }
  });

  test("should handle concurrent API requests", async () => {
    const { url } = createMockServer(() => Response.json({ id: 1 }));

    const endpoints = createEndpoints({
      getData: {
        method: "GET",
        output: z.object({ id: z.number() }),
        path: "/data",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });

    const results = await Promise.all([
      api.getData(),
      api.getData(),
      api.getData(),
    ]);

    expect(results.every((r) => r.isOk())).toBe(true);
    for (const r of results) {
      expect(r.isOk()).toBe(true);
    }
  });

  test("should handle realistic SSE stream", async () => {
    const { url } = createMockServer(() => {
      const stream = createSSEStream([
        { data: "Initializing...", event: "start" },
        { data: "Processing...", event: "progress" },
        { data: "Done!", event: "complete" },
      ]);
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const endpoints = createEndpoints({
      process: {
        method: "POST",
        output: z.object({ data: z.string(), event: z.string() }),
        path: "/process",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.process();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]?.event).toBe("start");
      expect(chunks[2]?.event).toBe("complete");
    }
  });
});

// Error Class Tests (6 tests)
describe("Error Classes", () => {
  test("ApiError should have statusCode and _tag", () => {
    const error = new ApiError({ statusCode: 404, text: "Not Found" });
    expect(error._tag).toBe("ApiError");
    expect(error.statusCode).toBe(404);
    expect(error.text).toBe("Not Found");
    expect(error).toBeInstanceOf(Error);
  });

  test("FetchError should have message and _tag", () => {
    const error = new FetchError({ message: "Network failure" });
    expect(error._tag).toBe("FetchError");
    expect(error.message).toBe("Network failure");
    expect(error).toBeInstanceOf(Error);
  });

  test("ParseError should have message and _tag", () => {
    const error = new ParseError({ message: "Invalid JSON" });
    expect(error._tag).toBe("ParseError");
    expect(error.message).toBe("Invalid JSON");
    expect(error).toBeInstanceOf(Error);
  });

  test("InputValidationError should have zodError and _tag", () => {
    const schema = z.object({ name: z.string() });
    const validationResult = schema.safeParse({ name: 123 });
    expect(validationResult.success).toBe(false);

    if (!validationResult.success) {
      const error = new InputValidationError({
        message: "Input validation failed",
        zodError: validationResult.error,
      });
      expect(error._tag).toBe("InputValidationError");
      expect(error.zodError).toBeDefined();
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("OutputValidationError should have zodError and _tag", () => {
    const schema = z.object({ id: z.number() });
    const validationResult = schema.safeParse({ id: "not-a-number" });
    expect(validationResult.success).toBe(false);

    if (!validationResult.success) {
      const error = new OutputValidationError({
        message: "Output validation failed",
        zodError: validationResult.error,
      });
      expect(error._tag).toBe("OutputValidationError");
      expect(error.zodError).toBeDefined();
      expect(error).toBeInstanceOf(Error);
    }
  });

  // oxlint-disable-next-line max-statements
  test("should discriminate errors by _tag field", () => {
    const apiError = new ApiError({ statusCode: 500, text: "Server Error" });
    const fetchError = new FetchError({ message: "Connection failed" });
    const parseError = new ParseError({ message: "Parse error" });

    const errors = [apiError, fetchError, parseError];

    for (const error of errors) {
      switch (error._tag) {
        case "ApiError": {
          expect(error.statusCode).toBeDefined();
          break;
        }
        case "FetchError": {
          expect(error.message).toBeDefined();
          break;
        }
        default: {
          expect(error.message).toBeDefined();
          break;
        }
      }
    }
  });
});

// Error Schema Validation Tests
describe("Error Schema Validation", () => {
  const errorSchema = z.object({
    code: z.string().optional(),
    message: z.string(),
  });

  test("should parse and validate error response with schema", async () => {
    const { url } = createMockServer(() =>
      Response.json(
        { code: "NOT_FOUND", message: "Resource not found" },
        { status: 404 }
      )
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints, errorSchema });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<{
        code?: string;
        message: string;
      }>;
      expect(apiError.statusCode).toBe(404);
      expect(apiError.data).toBeDefined();
      expect(apiError.data?.message).toBe("Resource not found");
      expect(apiError.data?.code).toBe("NOT_FOUND");
      expect(apiError.text).toContain("NOT_FOUND");
    }
  });

  test("should fallback to text when error JSON parse fails", async () => {
    const { url } = createMockServer(
      () => new Response("Invalid JSON", { status: 500 })
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints, errorSchema });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<unknown>;
      expect(apiError.statusCode).toBe(500);
      expect(apiError.data).toBeUndefined();
      expect(apiError.text).toBe("Invalid JSON");
    }
  });

  test("should fallback to text when error validation fails", async () => {
    const { url } = createMockServer(() =>
      Response.json(
        { error: "Something went wrong", status: "error" },
        { status: 400 }
      )
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints, errorSchema });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<unknown>;
      expect(apiError.statusCode).toBe(400);
      expect(apiError.data).toBeUndefined();
      expect(apiError.text).toContain("Something went wrong");
    }
  });

  test("should respect shouldValidateError function", async () => {
    const { url } = createMockServer(() =>
      Response.json(
        { code: "INTERNAL_ERROR", message: "Server error" },
        { status: 500 }
      )
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    // Only validate 4xx errors, not 5xx
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema,
      shouldValidateError: (statusCode) =>
        statusCode >= 400 && statusCode < 500,
    });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<unknown>;
      expect(apiError.statusCode).toBe(500);
      // Should not validate 500 errors
      expect(apiError.data).toBeUndefined();
      expect(apiError.text).toContain("INTERNAL_ERROR");
    }
  });

  test("should use default validation (4xx only)", async () => {
    // Test with 400 - should validate
    const { url: url400 } = createMockServer(() =>
      Response.json(
        { code: "BAD_REQUEST", message: "Invalid request" },
        { status: 400 }
      )
    );

    const endpoints400 = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api400 = createApi({
      baseUrl: url400,
      endpoints: endpoints400,
      errorSchema,
    });
    const result400 = await api400.getTodo();

    expect(result400.isErr()).toBe(true);
    if (result400.isErr()) {
      const apiError = result400.error as ApiError<{
        code?: string;
        message: string;
      }>;
      expect(apiError.statusCode).toBe(400);
      expect(apiError.data).toBeDefined();
      expect(apiError.data?.code).toBe("BAD_REQUEST");
    }

    // Test with 500 - should NOT validate
    const { url: url500 } = createMockServer(() =>
      Response.json(
        { code: "INTERNAL_ERROR", message: "Server error" },
        { status: 500 }
      )
    );

    const endpoints500 = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api500 = createApi({
      baseUrl: url500,
      endpoints: endpoints500,
      errorSchema,
    });
    const result500 = await api500.getTodo();

    expect(result500.isErr()).toBe(true);
    if (result500.isErr()) {
      const apiError = result500.error as ApiError<unknown>;
      expect(apiError.statusCode).toBe(500);
      expect(apiError.data).toBeUndefined();
    }
  });

  test("should work without error schema (backward compatibility)", async () => {
    const { url } = createMockServer(() =>
      Response.json({ error: "Not found" }, { status: 404 })
    );

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos/1",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.getTodo();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<unknown>;
      expect(apiError.statusCode).toBe(404);
      expect(apiError.data).toBeUndefined();
      expect(apiError.text).toContain("Not found");
    }
  });

  test("should validate error in streaming endpoint", async () => {
    const { url } = createMockServer(() =>
      Response.json(
        { code: "STREAM_ERROR", message: "Stream failed" },
        { status: 400 }
      )
    );

    const endpoints = createEndpoints({
      streamData: {
        method: "GET",
        output: z.object({ data: z.string() }),
        path: "/stream",
        stream: { enabled: true },
      },
    });

    const api = createApi({ baseUrl: url, endpoints, errorSchema });
    const result = await api.streamData();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<{
        code?: string;
        message: string;
      }>;
      expect(apiError.statusCode).toBe(400);
      expect(apiError.data).toBeDefined();
      expect(apiError.data?.message).toBe("Stream failed");
    }
  });
});
