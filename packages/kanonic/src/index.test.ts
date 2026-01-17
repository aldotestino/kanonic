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
