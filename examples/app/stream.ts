// stream.ts
// Demonstrates SSE streaming with:
//   - a typed output schema (each chunk validated against it)
//   - for-await-of iteration over the ReadableStream
//   - error handling before the stream opens
//
// Run: bun run stream.ts

import { createApi } from "@kanonic/fetch";

import { endpoints } from "./endpoints";

const api = createApi({
  baseUrl: "https://sse.dev",
  endpoints,
});

console.log("Connecting to SSE stream (5 chunks, 1s interval)…\n");

const result = await api.stream({ query: { interval: 1 } });

if (result.isErr()) {
  const { error } = result;
  switch (error._tag) {
    case "ApiError": {
      console.error(`HTTP ${error.statusCode}:`, error.text);
      break;
    }
    case "FetchError": {
      console.error("Network error:", error.message);
      break;
    }
    default: {
      console.error(error._tag, error.message);
    }
  }
  process.exit(1);
}

let count = 0;

for await (const chunk of result.value) {
  // chunk is typed: { msg: string; now: number; sse_dev: string; testing: boolean }
  const ts = new Date(chunk.now * 1000).toISOString();
  console.log(`[${ts}] ${chunk.msg}`);
  count += 1;
  if (count >= 5) {
    break;
  }
}

console.log("\nDone.");
