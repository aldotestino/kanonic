import type { Plugin } from "@kanonic/fetch";
import pino from "pino";

interface LoggerOptions {
  pinoOptions: pino.LoggerOptions;
  logDataOnSuccess?: boolean;
}

export const logger = (options: LoggerOptions) => {
  const pinoLogger = pino(options.pinoOptions);

  return {
    id: "logger",
    name: "Logger",
    version: "1.0.0",
    hooks: {
      async onRequest(ctx) {
        pinoLogger.info(`Sending request to [${ctx.method}] ${ctx.url}`);
        return ctx;
      },
      async onSuccess(_, response, data) {
        if (options.logDataOnSuccess) {
          pinoLogger.info(
            `Request succeeded with status ${response.status} and data: ${JSON.stringify(
              data
            )}`
          );
        } else {
          pinoLogger.info(`Request succeeded with status ${response.status}`);
        }
      },
      async onError(ctx, error) {
        pinoLogger.error(`Request failed [${error._tag}] ${error.message}`);
      },
      async onRetry() {
        pinoLogger.warn(`Request failed, retrying...`);
      },
    },
  } satisfies Plugin;
};
