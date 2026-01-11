import { z } from "zod";

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
    city: z.string(),
    geo: z.object({
      lat: z.string(),
      lng: z.string(),
    }),
    street: z.string(),
    suite: z.string(),
    zipcode: z.string(),
  }),
  company: z.object({
    bs: z.string(),
    catchPhrase: z.string(),
    name: z.string(),
  }),
  email: z.string(),
  id: z.number(),
  name: z.string(),
  phone: z.string(),
  username: z.string(),
  website: z.string(),
});
