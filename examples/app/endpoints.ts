// endpoints.ts
// Single source of truth for all schemas and endpoint definitions used across
// the other example files. All shapes come from JSONPlaceholder and sse.dev.

import { createEndpoints } from "kanonic";
import { z } from "zod";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const postSchema = z.object({
  id: z.number(),
  userId: z.number(),
  title: z.string(),
  body: z.string(),
});

export const commentSchema = z.object({
  id: z.number(),
  postId: z.number(),
  name: z.string(),
  email: z.string(),
  body: z.string(),
});

export const todoSchema = z.object({
  id: z.number(),
  userId: z.number(),
  title: z.string(),
  completed: z.boolean(),
});

export const userSchema = z.object({
  id: z.number(),
  name: z.string(),
  username: z.string(),
  email: z.string(),
  phone: z.string(),
  website: z.string(),
  address: z.object({
    street: z.string(),
    suite: z.string(),
    city: z.string(),
    zipcode: z.string(),
    geo: z.object({ lat: z.string(), lng: z.string() }),
  }),
  company: z.object({
    name: z.string(),
    catchPhrase: z.string(),
    bs: z.string(),
  }),
});

// Optional: schema for structured error bodies returned by the API
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ─── Endpoints ────────────────────────────────────────────────────────────────

export const endpoints = createEndpoints({
  // Todos
  getTodos: {
    method: "GET",
    path: "/todos",
    output: z.array(todoSchema),
  },
  getTodo: {
    method: "GET",
    path: "/todos/:id",
    params: z.object({ id: z.number() }),
    output: todoSchema,
  },
  createTodo: {
    method: "POST",
    path: "/todos",
    input: z.object({ title: z.string().min(1), userId: z.number() }),
    output: todoSchema,
  },
  updateTodo: {
    method: "PATCH",
    path: "/todos/:id",
    params: z.object({ id: z.number() }),
    input: z.object({ completed: z.boolean() }),
    output: todoSchema,
  },

  // Posts & comments
  getPosts: {
    method: "GET",
    path: "/posts",
    output: z.array(postSchema),
  },
  getPost: {
    method: "GET",
    path: "/posts/:id",
    params: z.object({ id: z.number() }),
    output: postSchema,
  },
  getComments: {
    method: "GET",
    path: "/posts/:postId/comments",
    params: z.object({ postId: z.number() }),
    output: z.array(commentSchema),
  },

  // Users
  getUsers: {
    method: "GET",
    path: "/users",
    output: z.array(userSchema),
  },
  getUser: {
    method: "GET",
    path: "/users/:id",
    params: z.object({ id: z.number() }),
    output: userSchema,
    // Endpoint-level requestOptions: applied to every call of this endpoint,
    // on top of any global requestOptions, but overridable per-call.
    requestOptions: {
      headers: { "X-Requires-Auth": "true" },
    },
  },

  // SSE stream
  stream: {
    method: "GET",
    path: "/test",
    query: z.object({ interval: z.number().int() }),
    output: z.object({
      msg: z.string(),
      now: z.number(),
      sse_dev: z.string(),
      testing: z.boolean(),
    }),
    stream: { enabled: true },
  },
});
