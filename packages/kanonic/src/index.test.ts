import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  createApi,
  createEndpoints,
  type ApiError,
  type FetchError,
  type InputValidationError,
  type OutputValidationError,
  type ParseError,
} from "./index";
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
      new Response(JSON.stringify({ id: 1, title: "Test" }))
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

  test("should make POST request with body", async () => {
    const { url } = createMockServer(async (req) => {
      const body = (await req.json()) as { title: string };
      return new Response(JSON.stringify({ id: 1, ...body }));
    });

    const endpoints = createEndpoints({
      createTodo: {
        input: z.object({ title: z.string() }),
        method: "POST",
        output: z.object({ id: z.number(), title: z.string() }),
        path: "/todos",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.createTodo({ input: { title: "New Todo" } });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe(1);
      expect(result.value.title).toBe("New Todo");
    }
  });

  test("should handle path params", async () => {
    const { url } = createMockServer((req) => {
      const id = new URL(req.url).pathname.split("/").pop();
      return new Response(JSON.stringify({ id: Number(id), title: "Test" }));
    });

    const endpoints = createEndpoints({
      getTodo: {
        method: "GET",
        output: z.object({ id: z.number(), title: z.string() }),
        params: z.object({ id: z.number() }),
        path: "/todos/:id",
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.getTodo({ params: { id: 42 } });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe(42);
    }
  });

  test("should handle query params", async () => {
    const { url } = createMockServer((req) => {
      const searchParams = new URL(req.url).searchParams;
      const userId = searchParams.get("userId");
      return new Response(
        JSON.stringify([
          { completed: false, id: 1, title: "Test", userId: Number(userId) },
        ])
      );
    });

    const endpoints = createEndpoints({
      getTodos: {
        method: "GET",
        output: z.array(
          z.object({
            completed: z.boolean(),
            id: z.number(),
            title: z.string(),
            userId: z.number(),
          })
        ),
        path: "/todos",
        query: z.object({ userId: z.number() }),
      },
    });

    const api = createApi({ baseUrl: url, endpoints });
    const result = await api.getTodos({ query: { userId: 1 } });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.userId).toBe(1);
    }
  });
});

// Authentication Tests (2 tests)
describe("Authentication", () => {
  test("should add Bearer token header", async () => {
    let authHeader = "";

    const { url } = createMockServer((req) => {
      authHeader = req.headers.get("Authorization") || "";
      return new Response(JSON.stringify({ success: true }));
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
      return new Response(JSON.stringify({ success: true }));
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
      new Response(JSON.stringify({ id: 1, title: "Test" }))
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
      new Response(JSON.stringify({ id: "invalid", title: "Test" }))
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
      new Response(JSON.stringify({ id: "invalid", title: "Test" }))
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
    const { url } = createMockServer(() =>
      new Response("Not Found", { status: 404 })
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
    const { url } = createMockServer(() =>
      new Response(JSON.stringify({ id: 1 }))
    );

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
    const { url } = createMockServer(() =>
      new Response("Not Found", { status: 404 })
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
        { user: { id: 1, name: "Alice" }, timestamp: 123 },
        { user: { id: 2, name: "Bob" }, timestamp: 456 },
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
