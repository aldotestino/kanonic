# kanonic

A lightweight, type-safe API client generator for TypeScript. Kanonic uses [Zod](https://zod.dev/) for robust validation and [Neverthrow](https://github.com/supermacro/neverthrow) for functional error handling, ensuring your API interactions are predictable and safe.

## Features

- **🚀 Fully Type-Safe**: Automatically infer request and response types from your schemas.
- **🛡️ Schema Validation**: Validate inputs (body, query, params) and outputs at runtime using Zod.
- **🛡️ Functional Error Handling**: No more `try/catch`. All methods return a `ResultAsync` containing either the data or a tagged error.
- **📡 Streaming Support**: Built-in support for Server-Sent Events (SSE).
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
        break;
      case "InputValidationError":
        console.error("Validation failed:", error.zodError.format());
        break;
      // ... handle other cases
    }
  }
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

Kanonic makes handling Server-Sent Events easy.

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

## Project Structure

This is a monorepo managed with Bun workspaces:

- `packages/kanonic`: The core library.
- `examples/todos`: A complete example using JSONPlaceholder.

## Error Types

Kanonic provides several built-in tagged error classes based on the `TaggedError` mixin:

- `ApiError`: Returned when the server responds with a status >= 400. Contains `statusCode` and `text`.
- `FetchError`: Returned when the network request fails.
- `ParseError`: Returned when the response body cannot be parsed.
- `InputValidationError`: Returned when the request data fails Zod validation.
- `OutputValidationError`: Returned when the server response fails Zod validation.

