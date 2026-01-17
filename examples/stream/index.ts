import { createApi, createEndpoints } from "kanonic";
import { z } from "zod";

const endpoints = createEndpoints({
  stream: {
    method: "GET",
    output: z.object({
      msg: z.string(),
      now: z.string(),
      sse_dev: z.string(),
      testing: z.boolean(),
    }),
    path: "/test",
    query: z.object({
      interval: z.int(),
    }),
    stream: {
      enabled: true,
    },
  },
});

const api = createApi({
  baseUrl: "https://sse.dev",
  endpoints,
  errorSchema: z.object({ message: z.string() }),
});

const myStream = await api.stream({
  query: {
    interval: 5,
  },
});

if (myStream.isErr()) {
  console.error(`[${myStream.error._tag}]: ${myStream.error.message}`);
} else {
  for await (const chunk of myStream.value) {
    console.log(chunk);
  }
}
