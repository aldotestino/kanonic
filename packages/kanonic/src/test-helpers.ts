import { afterAll } from "bun:test";

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
export const createSSEStream = (chunks: Array<string | object>) => {
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
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
};
