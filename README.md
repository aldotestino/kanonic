# kanonic

A lightweight, type-safe API client generator for TypeScript. Kanonic uses [Zod](https://zod.dev/) for robust validation and [Neverthrow](https://github.com/supermacro/neverthrow) for functional error handling, ensuring your API interactions are predictable and safe.

## Features

- **🚀 Fully Type-Safe**: Automatically infer request and response types from your schemas.
- **🛡️ Schema Validation**: Validate inputs (body, query, params) and outputs at runtime using Zod.
- **🔴 Typed Error Responses**: Define schemas for error responses with flexible validation control.
- **🛡️ Functional Error Handling**: No more `try/catch`. All methods return a `ResultAsync` containing either the data or a tagged error.
- **📡 Streaming Support**: Built-in support for Server-Sent Events (SSE) with type-safe, validated streams.
- **🏗️ Service-Oriented**: Easy to extend with a base `ApiService` class for shared logic.
- **🏷️ Tagged Errors**: Rich, serializable error objects with metadata.

## Quick Start

### 1. Define your Endpoints

Use `createEndpoints` to define your API contract. This provides excellent IDE autocompletion.

```typescript
import { createEndpoints } from "kanonic";
import { z } from "zod";

const todoSchema = z.object({
  id: z.number(),
  title: z.string(),
  completed: z.boolean(),
});

export const endpoints = createEndpoints({
  getTodo: {
    method: "GET",
    path: "/todos/:id",
    params: z.object({ id: z.number() }),
    output: todoSchema,
  },
  createTodo: {
    method: "POST",
    path: "/todos",
    input: z.object({ title: z.string() }),
    output: todoSchema,
  },
});
```

### 2. Create the Client

```typescript
import { createApi } from "kanonic";
import { endpoints } from "./endpoints";

const api = createApi({
  baseUrl: "https://jsonplaceholder.typicode.com",
  endpoints,
});

// Usage
const result = await api.getTodo({ params: { id: 1 } });

if (result.isOk()) {
  console.log(result.value.title); // Type-safe!
} else {
  console.error(result.error.message);
}
```

## Core Concepts

### Functional Error Handling

Kanonic uses `neverthrow`'s `ResultAsync`. This forces you to handle potential errors explicitly, leading to more resilient code.

```typescript
const result = await api.getTodo({ params: { id: 1 } });

result.match(
  (todo) => console.log("Success:", todo),
  (error) => {
    switch (error._tag) {
      case "ApiError":
        console.error("API returned status:", error.statusCode);
        // With errorSchema, error.data contains typed error response
        if (error.data) {
          console.error("Error message:", error.data.message);
        } else {
          console.error("Raw error:", error.text);
        }
        break;
      case "InputValidationError":
        console.error("Validation failed:", error.zodError.format());
        break;
      case "FetchError":
        console.error("Network error:", error.message);
        break;
      // ... handle other cases
    }
  }
);
```

**Combining multiple operations with `safeTry`:**

```typescript
import { safeTry, ok } from "neverthrow";

const result = await safeTry(async function* () {
  const user = yield* await api.getUser({ params: { id: 1 } });
  const posts = yield* await api.getUserPosts({ params: { userId: user.id } });

  return ok({ user, posts });
});

// If any operation fails, the error is automatically propagated
result.match(
  ({ user, posts }) => console.log("Got user and posts"),
  (error) => console.error("Something failed:", error)
);
```

### Using ApiService

For more complex scenarios, you can wrap the client in an `ApiService`. This is great for combining multiple API calls into a single operation.

```typescript
import { ApiService } from "kanonic";
import { ok, safeTry } from "neverthrow";
import { endpoints } from "./endpoints";

class TodoService extends ApiService(endpoints) {
  constructor(baseUrl: string) {
    super({ baseUrl });
  }

  async getEnrichedTodo(id: number) {
    const { api } = this;

    return safeTry(async function* () {
      const todo = yield* await api.getTodo({ params: { id } });
      // Combine with other logic...
      return ok({ ...todo, fetchedAt: new Date() });
    });
  }
}
```

### Streaming (SSE)

Kanonic makes handling Server-Sent Events easy with full type safety and validation support.

#### Basic Streaming (String)

```typescript
const endpoints = createEndpoints({
  streamUpdates: {
    method: "GET",
    path: "/updates",
    stream: { enabled: true },
  },
});

const api = createApi({ baseUrl: "...", endpoints });
const result = await api.streamUpdates();

if (result.isOk()) {
  const stream = result.value; // ReadableStream<string>
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    console.log("Update received:", value);
  }
}
```

#### Typed Streaming with Validation

Add an `output` schema to get typed, validated streams:

```typescript
const endpoints = createEndpoints({
  streamMessages: {
    method: "GET",
    path: "/messages",
    stream: { enabled: true },
    output: z.object({
      id: z.string(),
      content: z.string(),
      timestamp: z.number(),
    }),
  },
});

const api = createApi({ baseUrl: "...", endpoints });
const result = await api.streamMessages();

if (result.isOk()) {
  const stream = result.value; // ReadableStream<{ id: string, content: string, timestamp: number }>

  for await (const message of stream) {
    // message is fully typed!
    console.log(message.content);
  }
}
```

**How it works:**

- **No output schema**: Returns `ReadableStream<string>` with raw SSE data
- **Output schema provided**: Returns `ReadableStream<T>` where each line is parsed as JSON
  - `validateOutput: true` (default): Parses and validates each chunk
  - `validateOutput: false`: Parses JSON but skips validation
- **Invalid chunks**: Automatically skipped with a warning (stream continues)

### Authentication

Support for Bearer and Basic authentication is built-in.

```typescript
const api = createApi({
  baseUrl: "...",
  endpoints,
  auth: {
    type: "bearer",
    token: "your-token-here",
  },
});
```

### Typed Error Responses

Define a schema for error responses to get type-safe error handling. When the API returns an error (status >= 400) with structured JSON, Kanonic can parse and validate it.

```typescript
import { createApi, validateClientErrors } from "kanonic";
import { z } from "zod";

// Define your error response schema
const errorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

const api = createApi({
  baseUrl: "https://api.example.com",
  endpoints,
  errorSchema, // Optional: validates only 4xx errors by default
  shouldValidateError: validateClientErrors, // Optional: customize validation
});

const result = await api.getUser({ params: { id: 1 } });

result.match(
  (user) => console.log("Success:", user),
  (error) => {
    if (error._tag === "ApiError") {
      // error.data is typed based on your errorSchema
      if (error.data) {
        console.error(error.data.message); // Type-safe!
        console.error(error.data.code);
      } else {
        // Fallback to raw text when parsing/validation fails
        console.error(error.text);
      }
      console.error("Status:", error.statusCode);
    }
  }
);
```

**Validation strategies:**

- **Default**: Validates only 4xx errors (client errors) when `errorSchema` is provided
- **`validateClientErrors`**: Same as default (validates 4xx only)
- **`validateAllErrors`**: Validates all error responses (both 4xx and 5xx)
- **Custom function**: `shouldValidateError: (statusCode) => statusCode === 400 || statusCode === 422`

**Graceful fallback:**

- If JSON parsing fails → `error.data` is `undefined`, `error.text` contains raw response
- If validation fails → `error.data` is `undefined`, `error.text` contains raw response
- `error.text` is always available as a fallback

## Project Structure

This is a monorepo managed with Bun workspaces:

- **`packages/kanonic`**: The core library
- **`examples/todos`**: Complete example using JSONPlaceholder API
- **`examples/stream`**: Streaming (SSE) example with typed validation
- **`examples/errors`**: Typed error response handling examples

## Error Types

Kanonic provides several built-in tagged error classes based on the `TaggedError` mixin:

- **`ApiError<T>`**: Returned when the server responds with a status >= 400. Contains:
  - `statusCode`: HTTP status code
  - `text`: Raw response body (always available)
  - `data?: T`: Parsed error data (when `errorSchema` provided and validation succeeds)
  - `cause?`: Optional underlying error
- **`FetchError`**: Returned when the network request fails. Contains `message` and optional `cause`.
- **`ParseError`**: Returned when the response body cannot be parsed. Contains `message` and optional `cause`.
- **`InputValidationError`**: Returned when the request data fails Zod validation. Contains `message` and `zodError`.
- **`OutputValidationError`**: Returned when the server response fails Zod validation. Contains `message` and `zodError`.

All errors have a `_tag` field for discriminated union matching.

## Configuration Options

### `createApi` Options

```typescript
createApi({
  baseUrl: string;              // Base URL for all requests
  endpoints: T;                 // Endpoint definitions
  headers?: Record<string, string>; // Optional default headers
  auth?: Auth;                  // Optional authentication (bearer or basic)
  validateOutput?: boolean;     // Validate response data (default: true)
  validateInput?: boolean;      // Validate request data (default: true)
  errorSchema?: z.ZodType<E>;   // Optional schema for error responses
  shouldValidateError?: (statusCode: number) => boolean; // Control error validation
})
```

### Endpoint Definition

```typescript
{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/${string}`;           // Must start with /
  params?: z.ZodType;           // Path parameters (e.g., /users/:id)
  query?: z.ZodType;            // Query parameters
  input?: z.ZodType;            // Request body (not for GET)
  output?: z.ZodType;           // Response body
  stream?: { enabled: true };   // Enable SSE streaming
}
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run linter
bun run check

# Auto-fix linting issues
bun run fix

# Run examples
bun run examples/todos/index.ts
bun run examples/stream/index.ts
bun run examples/errors/index.ts
```

## Contributing

Contributions are welcome! Please ensure:

1. All tests pass (`bun test`)
2. Code follows the project style (`bun run check`)
3. New features include tests and documentation

## License

MIT
