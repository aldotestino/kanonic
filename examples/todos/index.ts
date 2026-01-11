// oxlint-disable require-hook
import { createEndpoints, ApiService } from "kanonic";
import { ok, safeTry } from "neverthrow";
import { z } from "zod";

import * as S from "./schema";

const endpoints = createEndpoints({
  getComments: {
    method: "GET",
    output: z.array(S.commentSchema),
    params: z.object({
      postId: z.number(),
    }),
    path: "/posts/:postId/comments",
  },
  getPost: {
    method: "GET",
    output: S.postSchema,
    params: z.object({
      id: z.number(),
    }),
    path: "/posts/:id",
  },
  getPosts: {
    method: "GET",
    output: z.array(S.postSchema),
    path: "/posts",
  },
  getTodo: {
    method: "GET",
    output: S.todoSchema,
    params: z.object({
      id: z.number(),
    }),
    path: "/todos/:id",
  },
  getTodos: {
    method: "GET",
    output: z.array(S.todoSchema),
    path: "/todos",
  },
  getUser: {
    method: "GET",
    output: S.userSchema,
    params: z.object({
      id: z.number(),
    }),
    path: "/users/:id",
  },
  getUsers: {
    method: "GET",
    output: z.array(S.userSchema),
    path: "/users",
  },
});

class TodoClient extends ApiService(endpoints) {
  constructor(baseUrl: string) {
    super({ baseUrl });
  }

  // add methods over the api client
  getEnrichedPost(id: number) {
    // we need to extract the api first
    // because the callback in safeTry
    // is not an arrow function and `this` is not bound to the class instance
    const { api } = this;

    // oxlint-disable-next-line func-names
    return safeTry(async function* () {
      const post = yield* await api.getPost({ params: { id } });
      const comments = yield* await api.getComments({ params: { postId: id } });

      const user = yield* await api.getUser({ params: { id: post.userId } });
      return ok({ comments, post, user });
    });
  }
}

const todoClient = new TodoClient("https://jsonplaceholder.typicode.com");

const enrichedPost = await todoClient.getEnrichedPost(1);

console.log(enrichedPost.unwrapOr(null));
