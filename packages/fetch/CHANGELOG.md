# @okfetch/fetch

## 0.6.0

### Minor Changes

- 1e9f8f5: Add a per-call `includeResponse` option that includes the underlying `Response` with successful data and API errors.

## 0.5.0

### Patch Changes

- 4e8e29c: Add `@okfetch/otel`, an OpenTelemetry HTTP semantic-conventions tracing plugin with explicit header and body-size capture, configurable credential redaction, retry events, error details, and trace-context propagation. Export plugin context types from `@okfetch/fetch`, preserve underlying error messages in `FetchError`, and invoke `onFail` for hook and response body-read failures. Route `@okfetch/api` input validation failures through plugin failure hooks so logging and tracing plugins can observe them without sending a network request.

## 0.4.2

### Patch Changes

- d86772f: Stop requiring consumers to install a specific TypeScript version. Published declarations remain compatible with TypeScript 5.4 and newer.
