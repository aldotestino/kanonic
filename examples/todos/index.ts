import { createEndpoints, createApi, type ApiClient } from "kanonic";
import { z } from "zod";

const endpoints = createEndpoints({
  getTodo: {
    method: "GET",
    output: z.object({
      completed: z.boolean(),
      id: z.number(),
      title: z.string(),
      userId: z.number(),
    }),
    params: z.object({
      id: z.number(),
    }),
    path: "/todos/:id",
  },
});

class TodoClient {
  private readonly client: ApiClient<typeof endpoints>;

  constructor(baseUrl: string) {
    this.client = createApi({
      baseUrl,
      endpoints,
    });
  }

  get api() {
    return this.client;
  }
}

const todoClient = new TodoClient("https://jsonplaceholder.typicode.com");

const todo = await todoClient.api.getTodo({ params: { id: 1 } });

if (todo.isOk()) {
  console.log(todo.value);
} else {
  console.error(todo.error.prettyPrint());
}
