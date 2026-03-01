// plugins.ts
// Example plugins demonstrating the kanonic plugin system.
//
// Two built-in example plugins are provided:
//   loggerPlugin  — logs every lifecycle event to the console (pure side-effects)
//   timingPlugin  — measures and reports end-to-end request duration

import type { Plugin, RequestContext } from "@kanonic/fetch";

// ─── Logger plugin ────────────────────────────────────────────────────────────

/**
 * A logger plugin that prints every lifecycle event to the console.
 * Has no `init` function — it only observes, never modifies.
 */
export const loggerPlugin: Plugin = {
  id: "logger",
  name: "Logger",
  version: "1.0.0",
  hooks: {
    async onRequest(ctx) {
      console.log(`[logger] → ${ctx.method} ${ctx.url}`);
      return ctx;
    },
    async onResponse(ctx, response) {
      console.log(
        `[logger] ← ${response.status} ${response.statusText || "(no status text)"} (${ctx.method} ${ctx.url})`
      );
      return response;
    },
    async onSuccess(_ctx, data) {
      console.log("[logger] ✓ success:", JSON.stringify(data).slice(0, 120));
    },
    async onError(_ctx, error) {
      console.error(`[logger] ✗ error [${error._tag}]:`, error.message);
    },
    async onRetry(ctx, error) {
      console.warn(
        `[logger] ↺ retrying ${ctx.method} ${ctx.url} after [${error._tag}]:`,
        error.message
      );
    },
  },
};

// ─── Timing plugin ────────────────────────────────────────────────────────────

// Stores per-request start timestamps keyed by a request ID we inject into ctx.
const timings = new Map<string, number>();

const logTotal = (ctx: RequestContext, symbol: string) => {
  const requestId = ctx._timingRequestId as string | undefined;
  if (!requestId) {
    return;
  }
  const start = timings.get(requestId);
  if (start === undefined) {
    return;
  }
  const totalMs = (performance.now() - start).toFixed(1);
  timings.delete(requestId);
  console.log(
    `[timing] ${symbol} total ${totalMs}ms for ${ctx.method} ${ctx.url}`
  );
};

/**
 * A timing plugin that measures the wall-clock time of each attempt and logs
 * the total duration once the request settles.
 *
 * Uses `init` to stamp the request context with a unique `requestId` so that
 * `onSuccess`/`onError` hooks can locate the start timestamp.
 */
export const timingPlugin: Plugin = {
  id: "timing",
  name: "Timing",
  version: "1.0.0",
  async init(url, options) {
    const requestId = crypto.randomUUID();
    timings.set(requestId, performance.now());
    // Attach the id as a non-standard field; downstream hooks read it via
    // the RequestContext index signature.
    return { url, options: { ...options, _timingRequestId: requestId } };
  },
  hooks: {
    async onRequest(ctx) {
      // Per-attempt timer for individual retry latency
      return { ...ctx, _attemptStart: performance.now() };
    },
    async onResponse(ctx, response) {
      const attemptStart = ctx._attemptStart as number | undefined;
      if (attemptStart !== undefined) {
        const ms = (performance.now() - attemptStart).toFixed(1);
        console.log(
          `[timing] attempt took ${ms}ms → ${response.status} ${ctx.method} ${ctx.url}`
        );
      }
      return response;
    },
    async onSuccess(ctx) {
      logTotal(ctx, "✓");
    },
    async onError(ctx) {
      logTotal(ctx, "✗");
    },
  },
};
