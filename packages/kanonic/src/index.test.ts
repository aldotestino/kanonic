import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ApiError,
  FetchError,
  InputValidationError,
  OutputValidationError,
  ParseError,
} from "./errors";
import {
  ApiService,
  createApi,
  createEndpoints,
  validateAllErrors,
  validateClientErrors,
  type RetryOptions,
} from "./index";

// Create a mock HTTP server for testing
export const createMockServer = (
  handler: (req: Request) => Response | Promise<Response>
) => {
  const server = Bun.serve({
    fetch: handler,
    port: 0, // Random available port
  });

  // Auto-cleanup after all tests
  afterAll(() => {
    server.stop();
  });

  return {
    server,
    stop: () => server.stop(),
    url: `http://localhost:${server.port}`,
  };
};

// Create an SSE-formatted ReadableStream for testing
export const createSSEStream = (chunks: (string | object)[]) => {
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

// Collect all chunks from a ReadableStream
export const collectStreamChunks = async <T>(
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

    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema,
      shouldValidateError: validateAllErrors,
    });
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

  test("should use default validation (no validation by default)", async () => {
    // Test with 400 - should NOT validate by default
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
      expect(apiError.data).toBeUndefined();
      expect(apiError.text).toContain("BAD_REQUEST");
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

    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema,
      shouldValidateError: validateClientErrors,
    });
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

  test("should work with ApiService class and errorSchema", async () => {
    const { url } = createMockServer(() =>
      Response.json(
        { code: "SERVICE_ERROR", message: "Service failed" },
        { status: 400 }
      )
    );

    const testEndpoints = createEndpoints({
      getData: {
        method: "GET",
        output: z.object({ data: z.string() }),
        path: "/data",
      },
    });

    const testErrorSchema = z.object({
      code: z.string(),
      message: z.string(),
    });

    class TestService extends ApiService(testEndpoints, testErrorSchema) {
      constructor(baseUrl: string) {
        super({ baseUrl, shouldValidateError: validateClientErrors });
      }
    }

    const service = new TestService(url);
    const result = await service.api.getData();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const apiError = result.error as ApiError<{
        code: string;
        message: string;
      }>;
      expect(apiError.statusCode).toBe(400);
      expect(apiError.data).toBeDefined();
      expect(apiError.data?.message).toBe("Service failed");
      expect(apiError.data?.code).toBe("SERVICE_ERROR");
    }
  });
});

describe("RequestOptions", () => {
  test("global requestOptions.headers are sent on every request", async () => {
    let capturedHeader: any = null;

    const { url } = createMockServer((req) => {
      capturedHeader = req.headers.get("x-global");
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpoints = createEndpoints({
      getUser: {
        method: "GET",
        path: "/users",
        output: z.object({ id: z.number(), name: z.string() }),
      },
    });

    const api = createApi({
      baseUrl: url,
      endpoints,
      requestOptions: { headers: { "x-global": "global-value" } },
    });

    await api.getUser();
    expect(capturedHeader).toBe("global-value");
  });

  test("endpoint-level requestOptions.headers are sent for that endpoint", async () => {
    let capturedHeader: any = null;

    const { url } = createMockServer((req) => {
      capturedHeader = req.headers.get("x-endpoint");
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpoints = createEndpoints({
      getUser: {
        method: "GET",
        path: "/users",
        output: z.object({ id: z.number(), name: z.string() }),
        requestOptions: { headers: { "x-endpoint": "endpoint-value" } },
      },
    });

    const api = createApi({ baseUrl: url, endpoints });

    await api.getUser();
    expect(capturedHeader).toBe("endpoint-value");
  });

  test("per-call requestOptions.headers are sent for that call", async () => {
    let capturedHeader: any = null;

    const { url } = createMockServer((req) => {
      capturedHeader = req.headers.get("x-call");
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpoints = createEndpoints({
      getUser: {
        method: "GET",
        path: "/users",
        output: z.object({ id: z.number(), name: z.string() }),
      },
    });

    const api = createApi({ baseUrl: url, endpoints });

    await api.getUser({ headers: { "x-call": "call-value" } });
    expect(capturedHeader).toBe("call-value");
  });

  test("per-call headers override endpoint headers which override global headers", async () => {
    const captured: Record<string, string> = {};

    const { url } = createMockServer((req) => {
      captured["x-layer"] = req.headers.get("x-layer") ?? "";
      captured["x-global-only"] = req.headers.get("x-global-only") ?? "";
      captured["x-endpoint-only"] = req.headers.get("x-endpoint-only") ?? "";
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpoints = createEndpoints({
      getUser: {
        method: "GET",
        path: "/users",
        output: z.object({ id: z.number(), name: z.string() }),
        requestOptions: {
          headers: { "x-layer": "endpoint", "x-endpoint-only": "yes" },
        },
      },
    });

    const api = createApi({
      baseUrl: url,
      endpoints,
      requestOptions: {
        headers: { "x-layer": "global", "x-global-only": "yes" },
      },
    });

    await api.getUser({ headers: { "x-layer": "call" } });

    expect(captured["x-layer"]).toBe("call");         // call wins
    expect(captured["x-global-only"]).toBe("yes");    // global flows through
    expect(captured["x-endpoint-only"]).toBe("yes");  // endpoint flows through
  });

  test("per-call headers on a zero-option endpoint (first arg is requestOptions)", async () => {
    let capturedHeader: any = null;

    const { url } = createMockServer((req) => {
      capturedHeader = req.headers.get("x-call");
      return Response.json([]);
    });

    const endpoints = createEndpoints({
      list: {
        method: "GET",
        path: "/items",
        output: z.array(z.unknown()),
      },
    });

    const api = createApi({ baseUrl: url, endpoints });

    // Zero-option endpoint: requestOptions is the first (and only) argument
    await api.list({ headers: { "x-call": "zero-option" } });
    expect(capturedHeader).toBe("zero-option");
  });

  test("global non-header requestOptions (cache) are forwarded to fetch", async () => {
    let requestReceived = false;

    const { url } = createMockServer(() => {
      requestReceived = true;
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpoints = createEndpoints({
      getUser: {
        method: "GET",
        path: "/users",
        output: z.object({ id: z.number(), name: z.string() }),
      },
    });

    // Just verify it doesn't throw — Bun's fetch accepts cache but may ignore it
    const api = createApi({
      baseUrl: url,
      endpoints,
      requestOptions: { cache: "no-store" },
    });

    const result = await api.getUser();
    expect(requestReceived).toBe(true);
    expect(result.isOk()).toBe(true);
  });

  test("AbortSignal via per-call requestOptions aborts the request", async () => {
    const { url } = createMockServer(async () => {
      await Bun.sleep(500);
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpoints = createEndpoints({
      getUser: {
        method: "GET",
        path: "/users",
        output: z.object({ id: z.number(), name: z.string() }),
      },
    });

    const api = createApi({ baseUrl: url, endpoints });

    const ac = new AbortController();
    // Abort immediately
    setTimeout(() => ac.abort(), 10);

    const result = await api.getUser({ signal: ac.signal });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("FetchError");
    }
  });

  test("endpoint-level requestOptions are not applied to other endpoints", async () => {
    const capturedA: Record<string, string> = {};
    const capturedB: Record<string, string> = {};

    const { url } = createMockServer((req) => {
      const path = new URL(req.url).pathname;
      const header = req.headers.get("x-only-a") ?? "";
      if (path === "/a") capturedA["x-only-a"] = header;
      if (path === "/b") capturedB["x-only-a"] = header;
      return Response.json({ id: 1 });
    });

    const endpoints = createEndpoints({
      getA: {
        method: "GET",
        path: "/a",
        output: z.object({ id: z.number() }),
        requestOptions: { headers: { "x-only-a": "yes" } },
      },
      getB: {
        method: "GET",
        path: "/b",
        output: z.object({ id: z.number() }),
      },
    });

    const api = createApi({ baseUrl: url, endpoints });

    await api.getA();
    await api.getB();

    expect(capturedA["x-only-a"]).toBe("yes");   // set on getA
    expect(capturedB["x-only-a"]).toBe("");       // not leaked to getB
  });
});

// Retry Tests (8 tests)
describe("Retry", () => {
  const endpoints = createEndpoints({
    getUser: {
      method: "GET",
      path: "/users",
      output: z.object({ id: z.number(), name: z.string() }),
    },
    createUser: {
      method: "POST",
      path: "/users",
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.number(), name: z.string() }),
    },
  });

  const retryOnce: RetryOptions = {
    times: 1,
    delayMs: 0,
    backoff: "constant",
  };

  test("succeeds on first try without retrying", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      return Response.json({ id: 1, name: "Alice" });
    });

    const api = createApi({ baseUrl: url, endpoints });

    const result = await api.getUser({ retry: retryOnce });

    expect(result.isOk()).toBe(true);
    expect(callCount).toBe(1);
  });

  test("retries on FetchError and succeeds", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      if (callCount < 2) {
        // Force a network error by closing the connection abruptly
        return new Response(null, { status: 500 });
      }
      return Response.json({ id: 1, name: "Alice" });
    });

    const apiErrorSchema = z.object({ message: z.string() });
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema: apiErrorSchema,
      shouldValidateError: validateAllErrors,
    });

    // Use shouldRetry that only retries ApiError with status 500
    const result = await api.getUser({
      retry: {
        times: 2,
        delayMs: 0,
        backoff: "constant",
        shouldRetry: (err) => err._tag === "ApiError" && err.statusCode === 500,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ id: 1, name: "Alice" });
    }
    expect(callCount).toBe(2);
  });

  test("retries on ApiError and succeeds", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      if (callCount < 3) {
        return Response.json({ message: "temporarily unavailable" }, { status: 503 });
      }
      return Response.json({ id: 2, name: "Bob" });
    });

    const apiErrorSchema = z.object({ message: z.string() });
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema: apiErrorSchema,
      shouldValidateError: validateAllErrors,
    });

    const result = await api.getUser({
      retry: { times: 3, delayMs: 0, backoff: "constant" },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ id: 2, name: "Bob" });
    }
    expect(callCount).toBe(3);
  });

  test("returns last error after all retries are exhausted", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      return Response.json({ message: "always fails" }, { status: 500 });
    });

    const apiErrorSchema = z.object({ message: z.string() });
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema: apiErrorSchema,
      shouldValidateError: validateAllErrors,
    });

    const result = await api.getUser({
      retry: { times: 2, delayMs: 0, backoff: "constant" },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ApiError");
      const err = result.error as ApiError<{ message: string }>;
      expect(err.statusCode).toBe(500);
      expect(err.data).toEqual({ message: "always fails" });
    }
    // initial attempt + 2 retries = 3 total calls
    expect(callCount).toBe(3);
  });

  test("stops retrying when shouldRetry returns false", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      return Response.json({ message: "client error" }, { status: 400 });
    });

    const apiErrorSchema = z.object({ message: z.string() });
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema: apiErrorSchema,
      shouldValidateError: validateClientErrors,
    });

    const result = await api.getUser({
      retry: {
        times: 3,
        delayMs: 0,
        backoff: "constant",
        shouldRetry: () => false,
      },
    });

    expect(result.isErr()).toBe(true);
    // shouldRetry returned false immediately — only 1 call (no retries)
    expect(callCount).toBe(1);
  });

  test("shouldRetry can selectively retry only ApiError (not FetchError)", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      return Response.json({ message: "server error" }, { status: 500 });
    });

    const apiErrorSchema = z.object({ message: z.string() });
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema: apiErrorSchema,
      shouldValidateError: validateAllErrors,
    });

    const errorsReceived: string[] = [];

    const result = await api.getUser({
      retry: {
        times: 2,
        delayMs: 0,
        backoff: "constant",
        shouldRetry: (err) => {
          errorsReceived.push(err._tag);
          return err._tag === "ApiError";
        },
      },
    });

    expect(result.isErr()).toBe(true);
    // All errors were ApiError and shouldRetry returned true each time → 3 calls total
    expect(callCount).toBe(3);
    expect(errorsReceived).toEqual(["ApiError", "ApiError"]);
  });

  test("validation errors are never retried regardless of shouldRetry", async () => {
    let callCount = 0;

    const { url } = createMockServer(() => {
      callCount++;
      return Response.json({ id: 1, name: "Alice" });
    });

    const endpointsWithInput = createEndpoints({
      createUser: {
        method: "POST",
        path: "/users",
        input: z.object({ name: z.string() }),
        output: z.object({ id: z.number(), name: z.string() }),
      },
    });

    const api = createApi({ baseUrl: url, endpoints: endpointsWithInput });

    const result = await api.createUser(
      // @ts-expect-error intentionally passing wrong input to trigger validation error
      { name: 42 },
      {
        retry: {
          times: 5,
          delayMs: 0,
          backoff: "constant",
          shouldRetry: () => true,
        },
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("InputValidationError");
    }
    // Validation happened locally; server was never called
    expect(callCount).toBe(0);
  });

  test("backoff strategies compute correct delays", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;

    // Patch setTimeout to capture delay values without waiting
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return origSetTimeout(fn, 0);
    }) as typeof globalThis.setTimeout;

    let callCount = 0;
    const { url } = createMockServer(() => {
      callCount++;
      if (callCount < 4) {
        return Response.json({ message: "fail" }, { status: 500 });
      }
      return Response.json({ id: 1, name: "Alice" });
    });

    const apiErrorSchema = z.object({ message: z.string() });
    const api = createApi({
      baseUrl: url,
      endpoints,
      errorSchema: apiErrorSchema,
      shouldValidateError: validateAllErrors,
    });

    await api.getUser({
      retry: { times: 3, delayMs: 100, backoff: "exponential" },
    });

    // Restore original
    globalThis.setTimeout = origSetTimeout;

    // exponential: 100*2^0=100, 100*2^1=200, 100*2^2=400
    expect(delays).toEqual([100, 200, 400]);
    expect(callCount).toBe(4);
  });
});
