// endpoints.ts
// Single source of truth for all schemas and endpoint definitions used across
// the other example files. All shapes come from JSONPlaceholder and sse.dev.

import { createEndpoints } from "kanonic";
import { z } from "zod";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const postSchema = z.object({
  body: z.string(),
  id: z.number(),
  title: z.string(),
  userId: z.number(),
});

export const commentSchema = z.object({
  body: z.string(),
  email: z.string(),
  id: z.number(),
  name: z.string(),
  postId: z.number(),
});

export const todoSchema = z.object({
  completed: z.boolean(),
  id: z.number(),
  title: z.string(),
  userId: z.number(),
});

export const userSchema = z.object({
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
  email: z.string(),
  id: z.number(),
  name: z.string(),
  phone: z.string(),
  username: z.string(),
  website: z.string(),
});

// Optional: schema for structured error bodies returned by the API
export const apiErrorSchema = z.object({
  code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  message: z.string(),
});

// ─── Endpoints ────────────────────────────────────────────────────────────────

export const endpoints = createEndpoints({
  // Todos
  getTodos: {
    method: "GET",
    output: z.array(todoSchema),
    path: "/todos",
  },
  getTodo: {
    method: "GET",
    output: todoSchema,
    params: z.object({ id: z.number() }),
    path: "/todos/:id",
  },
  createTodo: {
    input: z.object({ title: z.string().min(1), userId: z.number() }),
    method: "POST",
    output: todoSchema,
    path: "/todos",
  },
  updateTodo: {
    input: z.object({ completed: z.boolean() }),
    method: "PATCH",
    output: todoSchema,
    params: z.object({ id: z.number() }),
    path: "/todos/:id",
  },

  // Posts & comments
  getPosts: {
    method: "GET",
    output: z.array(postSchema),
    path: "/posts",
  },
  getPost: {
    method: "GET",
    output: postSchema,
    params: z.object({ id: z.number() }),
    path: "/posts/:id",
  },
  getComments: {
    method: "GET",
    output: z.array(commentSchema),
    params: z.object({ postId: z.number() }),
    path: "/posts/:postId/comments",
  },

  // Users
  getUsers: {
    method: "GET",
    output: z.array(userSchema),
    path: "/users",
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
    output: z.object({
      msg: z.string(),
      now: z.number(),
      sse_dev: z.string(),
      testing: z.boolean(),
    }),
    path: "/test",
    query: z.object({ interval: z.number().int() }),
    stream: { enabled: true },
  },
});
