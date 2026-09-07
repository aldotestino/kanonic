// oxlint-disable jest/no-conditional-in-test
import { describe, expect, test } from "bun:test";

import type { OkfetchFetch, OkfetchPlugin } from "@okfetch/fetch";
import { z } from "zod/v4";

import { ApiService, createApi, createEndpoints } from "./index";

const createMockFetch =
  (handler: (request: Request) => Response | Promise<Response>): OkfetchFetch =>
  async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    return handler(request);
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

describe("okfetch client package", () => {
  test("createApi returns a nested typed client", async () => {
    const mockFetch = createMockFetch((request) => {
      expect(request.url).toBe("https://api.example.com/users/7");
      return Response.json({ id: 7, name: "Ada" });
    });

    const endpoints = createEndpoints({
      users: {
        getById: {
          method: "GET",
          output: z.object({
            id: z.number(),
            name: z.string(),
          }),
          params: z.object({
            id: z.number(),
          }),
          path: "/users/:id",
        },
      },
    });

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints,
      fetch: mockFetch,
    });

    const result = await api.users.getById({ params: { id: 7 } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.name).toBe("Ada");
    }
  });

  test("zero-schema endpoints accept only request overrides", async () => {
    let requestHeader = "";

    const mockFetch = createMockFetch((request) => {
      requestHeader = request.headers.get("x-zero") ?? "";
      return Response.json({ ok: true });
    });

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        health: {
          method: "GET",
          path: "/health",
        },
      }),
      fetch: mockFetch,
    });

    const result = await api.health({
      headers: { "x-zero": "yes" },
    });

    expect(result.isOk()).toBe(true);
    expect(requestHeader).toBe("yes");
  });

  test("includes the response through per-call overrides", async () => {
    const response = Response.json({ ok: true }, { status: 202 });
    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        health: {
          method: "GET",
          output: z.object({ ok: z.boolean() }),
          path: "/health",
        },
      }),
      fetch: createMockFetch(() => response),
    });

    const result = await api.health({ includeResponse: true });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.data).toEqual({ ok: true });
      expect(result.value.response).toBe(response);
    }
  });

  test("per-call overrides win over endpoint and global defaults", async () => {
    const seenHeaders: string[] = [];
    let attempts = 0;

    const mockFetch = createMockFetch((request) => {
      attempts += 1;
      seenHeaders.push(request.headers.get("x-level") ?? "");

      if (attempts === 1) {
        return new Response("boom", { status: 503 });
      }

      return Response.json({ ok: true });
    });

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        retryable: {
          method: "GET",
          path: "/retryable",
          requestOptions: {
            headers: { "x-level": "endpoint" },
            retry: { attempts: 0, strategy: "fixed" },
          },
        },
      }),
      fetch: mockFetch,
      headers: { "x-level": "global" },
      retry: { attempts: 0, strategy: "fixed" },
    });

    const result = await api.retryable({
      headers: { "x-level": "call" },
      retry: { attempts: 1, strategy: "fixed" },
    });

    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(2);
    expect(seenHeaders).toEqual(["call", "call"]);
  });

  test("endpoint error schema overrides global error schema", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ code: "NOPE" }, { status: 400 })
    );

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        user: {
          error: z.object({ code: z.string() }),
          method: "GET",
          path: "/user",
        },
      }),
      errorSchema: z.object({ message: z.string() }),
      fetch: mockFetch,
    });

    const result = await api.user();
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      expect(result.error.data).toEqual({ code: "NOPE" });
    }
  });

  test("global error schema applies when endpoint error is absent", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ message: "No access" }, { status: 401 })
    );

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        me: {
          method: "GET",
          path: "/me",
        },
      }),
      errorSchema: z.object({ message: z.string() }),
      fetch: mockFetch,
    });

    const result = await api.me();
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      expect(result.error.data).toEqual({ message: "No access" });
    }
  });

  test("body, query and params validation fails before fetch through injected plugin", async () => {
    let calls = 0;
    const mockFetch = createMockFetch(() => {
      calls += 1;
      return Response.json({ ok: true });
    });

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        createUser: {
          body: z.object({ name: z.string() }),
          method: "POST",
          params: z.object({ id: z.number() }),
          path: "/users/:id",
          query: z.object({ verbose: z.boolean() }),
        },
      }),
      fetch: mockFetch,
    });

    const result = await api.createUser({
      body: { name: 123 } as unknown as { name: string },
      params: { id: "bad" } as unknown as { id: number },
      query: { verbose: true },
    });

    expect(result.isErr()).toBe(true);
    expect(calls).toBe(0);
    if (result.isErr()) {
      expect(result.error._tag).toBe("ValidationError");
    }
  });

  test("input validation failures run plugin failure hooks before fetch", async () => {
    let calls = 0;
    let observedErrorTag = "";
    const observerPlugin: OkfetchPlugin = {
      name: "observer",
      version: "1.0.0",
      hooks: {
        onFail: (_context, _response, error) => {
          observedErrorTag = error._tag;
        },
      },
    };
    const mockFetch = createMockFetch(() => {
      calls += 1;
      return Response.json({ ok: true });
    });
    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        createUser: {
          body: z.object({ name: z.string() }),
          method: "POST",
          path: "/users",
        },
      }),
      fetch: mockFetch,
      plugins: [observerPlugin],
    });

    const result = await api.createUser({
      body: { name: 123 } as unknown as { name: string },
    });

    expect(result.isErr()).toBe(true);
    expect(calls).toBe(0);
    expect(observedErrorTag).toBe("ValidationError");
  });

  test("validateInput false skips injected endpoint validation", async () => {
    let calls = 0;
    const mockFetch = createMockFetch((request) => {
      calls += 1;
      expect(request.url).toBe("https://api.example.com/users/not-a-number");
      return Response.json({ ok: true });
    });

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        createUser: {
          body: z.object({ name: z.string() }),
          method: "POST",
          params: z.object({ id: z.number() }),
          path: "/users/:id",
        },
      }),
      fetch: mockFetch,
      validateInput: false,
    });

    const result = await api.createUser({
      body: { name: 123 } as unknown as { name: string },
      params: { id: "not-a-number" } as unknown as { id: number },
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toBe(1);
  });

  test("global plugins run alongside injected validation plugin", async () => {
    let requestHeader = "";
    const observerPlugin: OkfetchPlugin = {
      name: "observer",
      version: "1.0.0",
      hooks: {
        onRequest: (context) => {
          context.headers.set("x-plugin", "active");
          return context;
        },
      },
    };

    const mockFetch = createMockFetch((request) => {
      requestHeader = request.headers.get("x-plugin") ?? "";
      return Response.json({ id: 1 });
    });

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        user: {
          method: "GET",
          output: z.object({ id: z.number() }),
          params: z.object({ id: z.number() }),
          path: "/users/:id",
        },
      }),
      fetch: mockFetch,
      plugins: [observerPlugin],
    });

    const result = await api.user({ params: { id: 1 } });
    expect(result.isOk()).toBe(true);
    expect(requestHeader).toBe("active");
  });

  test("stream endpoints return ReadableStream and validate chunks with endpoint output", async () => {
    const mockFetch = createMockFetch(
      () =>
        new Response(createSSEStream([{ id: 1 }, { id: 2 }]), {
          headers: { "content-type": "text/event-stream" },
        })
    );

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        events: {
          method: "GET",
          output: z.object({ id: z.number() }),
          path: "/events",
          stream: true,
        },
      }),
      fetch: mockFetch,
    });

    const result = await api.events();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const chunks = await collectStreamChunks(result.value);
      expect(chunks).toEqual([{ id: 1 }, { id: 2 }]);
    }
  });

  test("validateOutput false skips endpoint output validation", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ id: "unexpected-string" })
    );

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        user: {
          method: "GET",
          output: z.object({ id: z.number() }),
          path: "/user",
        },
      }),
      fetch: mockFetch,
      validateOutput: false,
    });

    const result = await api.user();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const rawValue = result.value as unknown;
      expect(rawValue).toEqual({ id: "unexpected-string" });
    }
  });

  test("shouldValidateError opt-out still parses global error schema data", async () => {
    const mockFetch = createMockFetch(() =>
      Response.json({ message: 42 }, { status: 401 })
    );

    const api = createApi({
      baseURL: "https://api.example.com",
      endpoints: createEndpoints({
        me: {
          method: "GET",
          path: "/me",
        },
      }),
      errorSchema: z.object({ message: z.string() }),
      fetch: mockFetch,
      shouldValidateError: () => false,
    });

    const result = await api.me();
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error._tag === "ApiError") {
      const rawData = result.error.data as unknown;
      expect(rawData).toEqual({ message: 42 });
      expect(result.error.text).toContain("42");
    }
  });

  test("ApiService exposes the typed client", async () => {
    const mockFetch = createMockFetch(() => Response.json({ title: "Hello" }));
    const endpoints = createEndpoints({
      posts: {
        getById: {
          method: "GET",
          output: z.object({ title: z.string() }),
          params: z.object({ id: z.number() }),
          path: "/posts/:id",
        },
      },
    });

    class BlogService extends ApiService(endpoints) {
      constructor() {
        super({
          baseURL: "https://api.example.com",
          fetch: mockFetch,
        });
      }
    }

    const service = new BlogService();
    const result = await service.api.posts.getById({ params: { id: 3 } });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.title).toBe("Hello");
    }
  });

  test("optional query schema fields omit explicit undefined values from the url", async () => {
    let requestUrl = "";
    const mockFetch = createMockFetch((request) => {
      requestUrl = request.url;
      return Response.json({ items: [] });
    });

    const endpoints = createEndpoints({
      catalog: {
        browse: {
          method: "GET",
          output: z.object({ items: z.array(z.string()) }),
          path: "/browse",
          query: z.object({
            cursor: z.string().optional(),
            limit: z.number(),
          }),
        },
      },
    });

    const api = createApi({
      baseURL: "https://example.com",
      endpoints,
      fetch: mockFetch,
    });

    // Mirrors a real integration failure: a conditional spread leaves an
    // explicit undefined behind, validation accepts it, and the transport
    // used to serialize it as the literal string "undefined".
    const cursor = undefined;

    const result = await api.catalog.browse({
      query: { cursor, limit: 3 },
    });

    expect(result.isOk()).toBe(true);
    expect(requestUrl).toBe("https://example.com/browse?limit=3");
  });
});
