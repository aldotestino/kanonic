[![CI](https://github.com/aldotestino/kanonic/actions/workflows/ci.yml/badge.svg)](https://github.com/aldotestino/kanonic/actions/workflows/ci.yml)

# kanonic

A lightweight, type-safe HTTP client generator for TypeScript. Define your API contract once as a schema, get a fully-typed client back — with zero `try/catch` and exhaustive error handling built in.

```ts
const result = await api.getTodo({ params: { id: 1 } });

result.match({
  ok: (todo) => console.log(todo.title), // todo is fully typed
  err: (error) => console.error(error), // error is a discriminated union
});
```

## Why kanonic?

Most HTTP clients give you a `Promise` that can throw anything. You write `try/catch`, hope the error has a `.message`, and move on. Kanonic takes a different approach.

**Every endpoint call returns a `Result<T, E>`** — a value that is either `Ok` (with your data) or `Err` (with a typed, structured error). You are forced to handle both paths. TypeScript guarantees you can't accidentally access `.value` without checking first. And because errors are tagged, you can exhaustively handle every failure mode with a `switch` statement.

**Schemas are the source of truth.** You define [Zod](https://zod.dev/) schemas for your requests, responses, path params, and query params. Kanonic validates at every boundary — input before sending, output after receiving — and surfaces validation failures as typed errors, not runtime exceptions.

The result: an API layer that is predictable, self-documenting, and refactor-safe.

## Features

- **Fully type-safe client** — request/response types inferred directly from your Zod schemas
- **Result-typed returns** — every method returns `Promise<Result<T, ApiErrors<E>>>`, never throws
- **Schema validation** — input (body, path params, query params) and output validated at runtime
- **Typed error responses** — define a schema for error bodies; `ApiError.data` is typed when parsing succeeds
- **Streaming (SSE)** — built-in Server-Sent Events support with optional per-chunk schema validation
- **Per-call retry** — configurable retry with constant, linear, or exponential backoff and a typed `shouldRetry` predicate
- **Service pattern** — `ApiService` base class for encapsulating and composing multiple API calls
- **Authentication** — bearer token and HTTP Basic auth out of the box
- **Tagged errors** — every error has a `_tag` for exhaustive `switch` matching

## Installation

```bash
# bun
bun add kanonic zod better-result

# npm
npm install kanonic zod better-result
```

Kanonic requires TypeScript 5+ and Zod 4+. `better-result` is used directly in your code for composing results with `Result.gen`, `Result.ok`, etc.

## Quick Start

### 1. Define your endpoints

`createEndpoints` is an identity function that captures the full type of your endpoint definitions for downstream inference.

```ts
import { createEndpoints } from "kanonic";
import { z } from "zod";

const todoSchema = z.object({
  id: z.number(),
  userId: z.number(),
  title: z.string(),
  completed: z.boolean(),
});

const endpoints = createEndpoints({
  getTodo: {
    method: "GET",
    path: "/todos/:id",
    params: z.object({ id: z.number() }),
    output: todoSchema,
  },
  createTodo: {
    method: "POST",
    path: "/todos",
    input: z.object({ title: z.string(), userId: z.number() }),
    output: todoSchema,
  },
  updateTodo: {
    method: "PATCH",
    path: "/todos/:id",
    params: z.object({ id: z.number() }),
    input: z.object({ completed: z.boolean() }),
    output: todoSchema,
  },
  deleteTodo: {
    method: "DELETE",
    path: "/todos/:id",
    params: z.object({ id: z.number() }),
  },
});
```

### 2. Create the client

```ts
import { createApi } from "kanonic";

const api = createApi({
  baseUrl: "https://api.example.com",
  endpoints,
});
```

### 3. Call endpoints

Every method returns a `Promise<Result<T, ApiErrors>>`. You never need a `try/catch`.

```ts
// Check with isOk()
const result = await api.getTodo({ params: { id: 1 } });

if (result.isOk()) {
  console.log(result.value.title); // typed as string
} else {
  console.error(result.error._tag); // "ApiError" | "FetchError" | ...
}

// Or use .match() for exhaustive handling
await api
  .createTodo({ input: { title: "Buy milk", userId: 1 } })
  .then((result) =>
    result.match({
      ok: (todo) => console.log("Created:", todo.id),
      err: (error) => console.error("Failed:", error.message),
    })
  );
```

## Core Concepts

### The Result type

Kanonic uses [`better-result`](https://github.com/dmmulroy/better-result) for all return values. A `Result<T, E>` is either `Ok<T>` or `Err<E>`. You can never accidentally access the value without handling the error case first.

```ts
const result = await api.getTodo({ params: { id: 1 } });

// Pattern 1: match() — exhaustive, returns a value
const title = result.match({
  ok: (todo) => todo.title,
  err: () => "Unknown",
});

// Pattern 2: isOk() guard — familiar, good for early returns
if (result.isOk()) {
  doSomethingWith(result.value); // narrowed to Ok
}

// Pattern 3: map/mapError — transform without unwrapping
const uppercased = result.map((todo) => todo.title.toUpperCase());
const withFallback = result.unwrapOr({
  id: 0,
  title: "fallback",
  completed: false,
  userId: 0,
});
```

### Composing multiple calls

Use `Result.gen` to sequence multiple API calls without nested `if` blocks. If any `yield*` produces an `Err`, the generator short-circuits and propagates that error directly — no additional error handling needed.

```ts
import { Result } from "better-result";

const result = await Result.gen(async function* () {
  // Each yield* either returns the value or short-circuits with the error
  const user = yield* Result.await(api.getUser({ params: { id: 1 } }));
  const posts = yield* Result.await(
    api.getUserPosts({ params: { userId: user.id } })
  );
  const comments = yield* Result.await(
    api.getComments({ params: { postId: posts[0].id } })
  );

  return Result.ok({ user, posts, comments });
});

// result is Result<{ user, posts, comments }, ApiErrors>
result.match({
  ok: ({ user, posts, comments }) =>
    console.log(user.name, posts.length, comments.length),
  err: (error) => console.error("One of the calls failed:", error._tag),
});
```

### Error handling

All errors are **tagged** with a `_tag` field. This enables exhaustive `switch` matching — TypeScript will warn you if you forget a case.

```ts
const result = await api.getTodo({ params: { id: 1 } });

if (result.isErr()) {
  const error = result.error;

  switch (error._tag) {
    case "FetchError":
      // Network failure — fetch() itself threw
      console.error("Network error:", error.message);
      break;

    case "ApiError":
      // Server responded with status >= 400
      console.error("HTTP", error.statusCode);
      console.error("Body:", error.text); // raw response body, always available
      break;

    case "InputValidationError":
      // Your input failed the endpoint's Zod schema before the request was sent
      console.error("Invalid input:", error.zodError.issues);
      break;

    case "OutputValidationError":
      // The server's response didn't match the output schema
      console.error("Unexpected response shape:", error.zodError.issues);
      break;

    case "ParseError":
      // Response body could not be read or JSON-parsed
      console.error("Parse failure:", error.message);
      break;
  }
}
```

### Typed error responses

When your API returns structured error JSON (e.g. `{ code: "NOT_FOUND", message: "..." }`), you can define an `errorSchema` so that `ApiError.data` is fully typed.

```ts
import { createApi, validateClientErrors } from "kanonic";
import { z } from "zod";

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const api = createApi({
  baseUrl: "https://api.example.com",
  endpoints,
  errorSchema,
  shouldValidateError: validateClientErrors, // parse 4xx errors
});

const result = await api.getUser({ params: { id: 999 } });

if (result.isErr() && result.error._tag === "ApiError") {
  const { error } = result;

  if (error.data) {
    // Typed: { code: string; message: string; details?: Record<string, unknown> }
    console.error(error.data.code); // "NOT_FOUND"
    console.error(error.data.message); // "User not found"
  } else {
    // Parsing or validation failed — fall back to raw text
    console.error(error.text);
  }
}
```

**Validation strategies** for `shouldValidateError`:

| Strategy                  | Behavior                                                  |
| ------------------------- | --------------------------------------------------------- |
| _(not set)_               | No error body parsing, `error.data` is always `undefined` |
| `validateClientErrors`    | Parse 4xx responses only                                  |
| `validateAllErrors`       | Parse all error responses (4xx and 5xx)                   |
| `(statusCode) => boolean` | Custom predicate for full control                         |

**Graceful fallback:** if JSON parsing or Zod validation fails on an error body, `error.data` is `undefined` and `error.text` always contains the raw response body. The client never throws.

### Schema validation

Kanonic validates at four points in the request lifecycle:

**Input body** (`input` schema, non-GET only) — validated before the request is sent. Failure returns `InputValidationError` immediately without making a network call.

```ts
const endpoints = createEndpoints({
  createUser: {
    method: "POST",
    path: "/users",
    input: z.object({
      name: z.string().min(1),
      email: z.email(),
      age: z.number().int().positive(),
    }),
    output: z.object({ id: z.number(), name: z.string() }),
  },
});
```

**Path params** (`params` schema) — substituted into the path via `:paramName` placeholders after validation.

```ts
// /users/:id → /users/42
params: z.object({ id: z.number() });
```

**Query params** (`query` schema) — appended to the URL as a query string after validation. Arrays become repeated keys (`?tag=a&tag=b`). `null`/`undefined` values are omitted.

```ts
query: z.object({
  page: z.number().optional(),
  limit: z.number().optional(),
  tags: z.array(z.string()).optional(),
});
```

**Response output** (`output` schema) — the parsed JSON response is validated against the schema. Failure returns `OutputValidationError`. Set `validateOutput: false` to skip this step.

To disable input validation globally: `validateInput: false`.

### Authentication

```ts
// Bearer token
const api = createApi({
  baseUrl: "https://api.example.com",
  endpoints,
  auth: { type: "bearer", token: "your-jwt-or-api-key" },
});

// HTTP Basic
const api = createApi({
  baseUrl: "https://api.example.com",
  endpoints,
  auth: { type: "basic", username: "user", password: "pass" },
});
```

### Request options

Every `fetch` call kanonic makes can be customised at three levels. The levels merge together — later levels win — with `Content-Type: application/json` always applied last and never overridable.

**Merge order (lowest → highest priority):**

```
auth (Authorization header)
  ↓ global requestOptions.headers
    ↓ endpoint requestOptions.headers
      ↓ per-call requestOptions.headers
        ↓ Content-Type: application/json  ← always wins
```

#### Global — applied to every request

```ts
const api = createApi({
  baseUrl: "https://api.example.com",
  endpoints,
  auth: { type: "bearer", token: "..." },
  requestOptions: {
    headers: { "X-Api-Version": "2" },
    cache: "no-store",
    credentials: "include",
  },
});
```

#### Endpoint-level — applied to every call of that endpoint

Useful for headers that are specific to a single endpoint (e.g. an auth scope or cache directive) without affecting the rest of the client.

```ts
const endpoints = createEndpoints({
  getUser: {
    method: "GET",
    path: "/users/:id",
    params: z.object({ id: z.number() }),
    output: userSchema,
    requestOptions: {
      headers: { "X-Requires-Auth": "true" },
      cache: "no-cache",
    },
  },
});
```

#### Per-call — passed as a second argument at the call site

For endpoints **with** schema options (`input`, `params`, `query`), `requestOptions` is the second argument:

```ts
const ac = new AbortController();

const result = await api.getUser(
  { params: { id: 1 } },
  { signal: ac.signal, headers: { "X-Request-Id": "abc123" } }
);
```

For endpoints **with no** schema options, `requestOptions` is the first (and only) argument:

```ts
// api.listUsers() — no input/params/query
const result = await api.listUsers({ signal: ac.signal });
```

#### Retry — per-call automatic retries

Add a `retry` key to the per-call `requestOptions` to enable automatic retries. Retry is intentionally **only available at call level** — it cannot be set globally or per-endpoint.

```ts
const result = await api.getUser(
  { params: { id: 1 } },
  {
    retry: {
      times: 3, // retries after the first attempt; total calls = times + 1
      delayMs: 200, // base delay in milliseconds
      backoff: "exponential", // delay schedule (see table below)
      // Optional predicate — return true to retry, false to stop.
      // Only receives retriable errors: FetchError or ApiError<E>.
      // Validation errors (InputValidationError, OutputValidationError, ParseError)
      // are never retried regardless of this predicate.
      shouldRetry: (error) => {
        if (error._tag === "FetchError") return true; // always retry network errors
        return error.statusCode >= 500; // only retry 5xx, not 4xx
      },
    },
  }
);
```

**Backoff strategies** (`d = delayMs`, attempt is 0-indexed from the first retry):

| `backoff`       | Formula             | Example (`delayMs: 100`) |
| --------------- | ------------------- | ------------------------ |
| `"constant"`    | `d`                 | 100ms, 100ms, 100ms      |
| `"linear"`      | `d × (attempt + 1)` | 100ms, 200ms, 300ms      |
| `"exponential"` | `d × 2^attempt`     | 100ms, 200ms, 400ms      |

**Key behaviours:**

- `shouldRetry` defaults to always retry if omitted
- The initial attempt is not counted — `times: 3` means up to 3 retries (4 total calls)
- Validation errors (`InputValidationError`, `OutputValidationError`, `ParseError`) are **never** retried
- If `shouldRetry` returns `false`, retrying stops immediately and the last error is returned

### The ApiService class

`ApiService` is a class factory for the service-oriented pattern. You bake in the endpoint definitions (and optionally an error schema) at class definition time, then instantiate the service with runtime configuration like `baseUrl` and `auth`.

This pattern is useful when you want to:

- Encapsulate related endpoints behind a service interface
- Add domain-specific methods that compose multiple API calls
- Share the client between methods without passing it around

```ts
import { ApiService, validateClientErrors } from "kanonic";
import { Result } from "better-result";
import { z } from "zod";

const postSchema = z.object({
  id: z.number(),
  title: z.string(),
  userId: z.number(),
});
const commentSchema = z.object({
  id: z.number(),
  postId: z.number(),
  body: z.string(),
});
const userSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
});

const endpoints = createEndpoints({
  getPost: {
    method: "GET",
    path: "/posts/:id",
    params: z.object({ id: z.number() }),
    output: postSchema,
  },
  getComments: {
    method: "GET",
    path: "/posts/:postId/comments",
    params: z.object({ postId: z.number() }),
    output: z.array(commentSchema),
  },
  getUser: {
    method: "GET",
    path: "/users/:id",
    params: z.object({ id: z.number() }),
    output: userSchema,
  },
});

const errorSchema = z.object({ message: z.string() });

class BlogService extends ApiService(endpoints, errorSchema) {
  constructor(baseUrl: string) {
    super({ baseUrl, shouldValidateError: validateClientErrors });
  }

  // Compose multiple calls into a single typed result
  async getEnrichedPost(id: number) {
    const { api } = this; // destructure to preserve `this` inside the generator

    return Result.gen(async function* () {
      const post = yield* Result.await(api.getPost({ params: { id } }));
      const comments = yield* Result.await(
        api.getComments({ params: { postId: post.id } })
      );
      const author = yield* Result.await(
        api.getUser({ params: { id: post.userId } })
      );

      return Result.ok({ post, comments, author });
    });
  }
}

const blog = new BlogService("https://jsonplaceholder.typicode.com");

const result = await blog.getEnrichedPost(1);

result.match({
  ok: ({ post, comments, author }) => {
    console.log(
      `"${post.title}" by ${author.name} — ${comments.length} comments`
    );
  },
  err: (error) => console.error(error._tag, error.message),
});
```

> **Note:** Inside `Result.gen`, destructure `const { api } = this` before the generator function. Arrow functions don't apply here since the generator syntax requires `function*`, so `this` would be unbound inside.

### Streaming (SSE)

Kanonic has built-in support for Server-Sent Events. Set `stream: { enabled: true }` on an endpoint and the return type becomes `ReadableStream<T>` instead of a plain value.

#### Untyped streaming

Without an `output` schema, the stream emits raw strings — one per SSE `data:` line.

```ts
const endpoints = createEndpoints({
  streamUpdates: {
    method: "GET",
    path: "/events",
    stream: { enabled: true },
  },
});

const api = createApi({ baseUrl: "https://api.example.com", endpoints });
const result = await api.streamUpdates();

if (result.isOk()) {
  for await (const line of result.value) {
    // ReadableStream<string>
    console.log(line);
  }
}
```

#### Typed streaming

Add an `output` schema and each SSE data line is JSON-parsed and Zod-validated. Invalid chunks are silently skipped (with a `console.warn`) so the stream never aborts on a bad chunk.

```ts
const endpoints = createEndpoints({
  streamMessages: {
    method: "GET",
    path: "/messages/stream",
    stream: { enabled: true },
    output: z.object({
      id: z.string(),
      content: z.string(),
      timestamp: z.number(),
    }),
  },
});

const api = createApi({ baseUrl: "https://api.example.com", endpoints });
const result = await api.streamMessages();

if (result.isOk()) {
  for await (const message of result.value) {
    // message is { id: string; content: string; timestamp: number }
    console.log(`[${message.id}] ${message.content}`);
  }
}
```

**How SSE lines are processed:**

- Lines not starting with `data:` are ignored (comments, event names, etc.)
- Empty `data:` values are ignored
- `data: [DONE]` (OpenAI-style sentinel) is ignored
- Incomplete lines split across network chunks are buffered and reassembled
- If `output` is provided and `validateOutput: true`, invalid chunks are skipped with a warning
- HTTP errors before the stream starts return `ApiError` in the `Err` path — the `ReadableStream` is never created

## Error reference

All errors extend `Error` and are safe to `throw`, serialize with `toJSON()`, and discriminate with `instanceof` or `._tag`.

| Class                   | `_tag`                    | When                                          | Key fields                                       |
| ----------------------- | ------------------------- | --------------------------------------------- | ------------------------------------------------ |
| `ApiError<T>`           | `"ApiError"`              | Server returned status >= 400                 | `statusCode: number`, `text: string`, `data?: T` |
| `FetchError`            | `"FetchError"`            | `fetch()` threw (network down, bad URL, etc.) | `message: string`, `cause?: unknown`             |
| `ParseError`            | `"ParseError"`            | Response body could not be read or parsed     | `message: string`, `cause?: unknown`             |
| `InputValidationError`  | `"InputValidationError"`  | Request data failed Zod validation            | `message: string`, `zodError: z.ZodError`        |
| `OutputValidationError` | `"OutputValidationError"` | Response data failed Zod validation           | `message: string`, `zodError: z.ZodError`        |

All errors have a `_tag` discriminant. `ApiError<T>` carries a generic that types `error.data` when an `errorSchema` is used.

## API reference

### `createEndpoints(endpoints)`

Identity function. Pass your endpoint record; get back a fully-typed version. Use this to trigger TypeScript inference before passing endpoints to `createApi` or `ApiService`.

### `createApi(options)`

Creates the typed API client.

```ts
createApi({
  baseUrl: string;                                        // Required
  endpoints: T;                                           // Required — from createEndpoints()
  auth?: { type: "bearer"; token: string }
        | { type: "basic"; username: string; password: string };
  requestOptions?: RequestOptions;                        // Global fetch options (incl. headers)
  validateInput?: boolean;                                // Default: true
  validateOutput?: boolean;                               // Default: true
  errorSchema?: z.ZodType<E>;                             // Schema for error bodies
  shouldValidateError?: (statusCode: number) => boolean;  // Which errors to parse
})
```

Returns an `ApiClient<T, E>` where each endpoint is a function with one of two signatures depending on whether the endpoint has schema options (`input`, `params`, `query`):

- **No schema options**: `(requestOptions?: RequestOptions<E>) => Promise<Result<...>>`
- **With schema options**: `(options: EndpointOptions, requestOptions?: RequestOptions<E>) => Promise<Result<...>>`

### `RequestOptions<E>`

A subset of `RequestInit` (excludes `body` and `method`). Can include a `retry` field at the per-call level.

```ts
type RequestOptions<E = unknown> = Omit<RequestInit, "body" | "method"> & {
  retry?: RetryOptions<E>;
};
```

### `RetryOptions<E>`

```ts
type RetryOptions<E = unknown> = {
  times: number; // Number of retries (not counting initial)
  delayMs: number; // Base delay in milliseconds
  backoff: "constant" | "linear" | "exponential";
  shouldRetry?: (error: FetchError | ApiError<E>) => boolean; // Defaults to always retry
};
```

### `ApiService(endpoints, errorSchema?)`

Class factory. Returns a base class that your service can extend.

```ts
class MyService extends ApiService(endpoints, errorSchema) {
  constructor(baseUrl: string) {
    super({
      baseUrl,              // Required
      auth?,                // Optional
      requestOptions?,      // Optional — global fetch options
      validateInput?,       // Optional
      validateOutput?,      // Optional
      shouldValidateError?, // Optional
    });
  }
}
```

The service exposes `this.api` (and `protected this.client`) as the typed `ApiClient<T, E>`.

### `validateClientErrors`

Preset `shouldValidateError` predicate. Returns `true` for 4xx status codes only.

### `validateAllErrors`

Preset `shouldValidateError` predicate. Returns `true` for all error responses.

### Endpoint shape

```ts
{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;                  // Must start with /
  params?: z.ZodType;                  // Path parameter schema (:paramName substitution)
  query?: z.ZodType;                   // Query string schema
  input?: z.ZodType;                   // Request body schema (non-GET only)
  output?: z.ZodType;                  // Response body schema
  stream?: { enabled: true };          // Enable SSE streaming
  requestOptions?: RequestOptions;     // Endpoint-level fetch options
}
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test --cwd packages/kanonic

# Run examples
bun run --cwd examples/app client.ts   # createApi, error handling, validation
bun run --cwd examples/app service.ts  # ApiService, Result.gen composition
bun run --cwd examples/app stream.ts   # SSE streaming with typed chunks
```

## Project Structure

```
packages/kanonic/   core library
examples/app/
  endpoints.ts      shared schemas and endpoint definitions
  client.ts         createApi — typed errors, validation, result chaining
  service.ts        ApiService — Result.gen composition across multiple calls
  stream.ts         SSE streaming with per-chunk Zod validation
```

## License

MIT
