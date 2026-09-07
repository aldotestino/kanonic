# @okfetch/fetch

`@okfetch/fetch` is the transport core of the okfetch ecosystem.

It wraps the standard `fetch` API with:

- `Result`-based error handling via `better-result`
- Standard Schema-compatible response validation
- request retries and timeouts
- auth helpers
- lifecycle plugins
- SSE-style stream parsing

If you want typed HTTP calls without building a full generated client, this is the package to start with.

## Installation

```bash
bun add @okfetch/fetch better-result
```

```bash
npm install @okfetch/fetch better-result
```

## What It Exports

Functions:

- `okfetch`
- `validateClientErrors`
- `validateAllErrors`

Errors:

- `FetchError`
- `TimeoutError`
- `ApiError`
- `ParseError`
- `ValidationError`
- `PluginError`

Types:

- `OkfetchOptions`
- `OkfetchError`
- `OkfetchPlugin`
- `OkfetchPluginHooks`
- `OkfetchSuccess`
- `RetryOptions`
- `Auth`

## Quick Example

```ts
import { okfetch } from "@okfetch/fetch";
import { z } from "zod/v4";

const todoSchema = z.object({
  completed: z.boolean(),
  id: z.number(),
  title: z.string(),
  userId: z.number(),
});

const result = await okfetch("https://jsonplaceholder.typicode.com/todos/1", {
  outputSchema: todoSchema,
});

result.match({
  err: (error) => console.error(error._tag, error.message),
  ok: (todo) => console.log(todo.title),
});
```

## Request Options

`okfetch(url, options)` accepts standard `fetch` options plus okfetch-specific behavior:

- `outputSchema`
- `apiErrorDataSchema`
- `baseURL`
- `params`
- `query`
- `body`
- `auth`
- `timeout`
- `stream`
- `validateOutput`
- `shouldValidateError`
- `includeResponse`
- `plugins`
- `retry`
- `fetch`

Any schema object that implements Standard Schema v1 can be used for `outputSchema` and `apiErrorDataSchema`.

Set `includeResponse: true` on an individual call when you need response metadata. Successful
results then contain `{ data, response }`; by default they continue to contain the parsed data
directly. `ApiError.response` is also populated when the flag is enabled.

```ts
const result = await okfetch("https://example.com/todos/1", {
  includeResponse: true,
  outputSchema: todoSchema,
});

if (result.isOk()) {
  console.log(result.value.data, result.value.response.status);
}
```

### URL building

You can pass a fully qualified URL directly, or combine a relative path with `baseURL`.

Path params are replaced from `params`, and query strings are built from `query`.

```ts
await okfetch("/users/:id", {
  baseURL: "https://api.example.com",
  method: "GET",
  params: { id: 42 },
  query: { include: ["teams", "profile"] },
});
```

### Validation

`outputSchema` validates successful responses:

```ts
await okfetch("https://api.example.com/me", {
  outputSchema: z.object({
    id: z.string(),
    email: z.string().email(),
  }),
});
```

Providing `apiErrorDataSchema` parses structured error bodies into `ApiError.data`, validated against the schema by default:

```ts
await okfetch("https://api.example.com/me", {
  apiErrorDataSchema: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
```

`shouldValidateError` limits validation to specific status codes. Statuses it excludes still get the JSON-parsed body on `ApiError.data`, just without validation — the schema then only types the data. When validation runs and fails, the raw parsed body is kept on `data` instead of being dropped.

```ts
import { validateClientErrors } from "@okfetch/fetch";

await okfetch("https://api.example.com/me", {
  apiErrorDataSchema: z.object({
    code: z.string(),
    message: z.string(),
  }),
  // only validate 4xx responses; 5xx bodies are parsed but not validated
  shouldValidateError: validateClientErrors,
});
```

### Retries

Supported strategies:

- `fixed`
- `linear`
- `exponential`

```ts
await okfetch("https://api.example.com/me", {
  retry: {
    attempts: 3,
    initialDelay: 100,
    strategy: "exponential",
  },
});
```

### Auth

Built-in auth shapes:

- `{ type: "basic", username, password }`
- `{ type: "bearer", token }`
- `{ type: "custom", prefix, value }`

```ts
await okfetch("https://api.example.com/me", {
  auth: {
    type: "bearer",
    token: process.env.API_TOKEN ?? "",
  },
});
```

### Plugins

Plugins are a core extension point.

```ts
import type { OkfetchPlugin } from "@okfetch/fetch";

const plugin: OkfetchPlugin = {
  name: "timing",
  version: "1.0.0",
  hooks: {
    onRequest(context) {
      console.log("->", context.method, context.url.toString());
      return context;
    },
    onFail(_context, _response, error) {
      console.error(error._tag, error.message);
    },
  },
};
```

Available lifecycle hooks:

- `init`
- `onRequest`
- `onResponse`
- `onSuccess`
- `onFail`
- `onRetry`

`onFail` runs for every failure after the request context is built: transport, timeout, API, parse and validation errors, plus errors thrown by `onRequest` or `onResponse` hooks and failures reading the response body. `init` failures happen before a request context exists and are returned without calling `onFail`.

### Streaming

Set `stream: true` to receive a `ReadableStream`.

```ts
const result = await okfetch("https://example.com/events", {
  stream: true,
  outputSchema: z.object({
    id: z.number(),
    message: z.string(),
  }),
});
```

When an `outputSchema` is present, each SSE `data:` chunk is parsed and validated independently.

## Error Handling

`okfetch` never throws expected HTTP, parsing, timeout, or validation failures from the request API itself. Instead it returns tagged errors inside the `Result`.

Use `match` when you want explicit branching:

```ts
result.match({
  err: (error) => {
    if (error._tag === "ApiError") {
      console.error(error.statusCode, error.data);
    }
  },
  ok: (data) => console.log(data),
});
```

## Related Packages

- `@okfetch/api` builds typed API clients on top of this package
- `@okfetch/logger` provides a ready-made logging plugin
