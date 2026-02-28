// service.ts
// Demonstrates the ApiService class pattern with:
//   - endpoint and errorSchema baked in at class definition time
//   - Result.gen for composing multiple API calls without nested error handling
//   - a domain method that returns a single typed Result
//
// Run: bun run service.ts

import { ApiService, validateClientErrors } from "kanonic";
import { Result } from "better-result";
import { apiErrorSchema, endpoints } from "./endpoints";

// ─── Service definition ───────────────────────────────────────────────────────

class BlogService extends ApiService(endpoints, apiErrorSchema) {
  constructor(baseUrl: string) {
    super({ baseUrl, shouldValidateError: validateClientErrors });
  }

  // Fetch a post, its comments, and its author in one typed operation.
  // Result.gen short-circuits on the first Err — no try/catch, no nested ifs.
  getEnrichedPost(id: number) {
    const { api } = this; // destructure: generator callbacks aren't arrow fns

    return Result.gen(async function* () {
      const post = yield* Result.await(api.getPost({ params: { id } }));
      const comments = yield* Result.await(
        api.getComments({ params: { postId: post.id } }),
      );
      const author = yield* Result.await(
        api.getUser({ params: { id: post.userId } }),
      );

      return Result.ok({ post, comments, author });
    });
  }

  // Fetch all todos for a user and return only the incomplete ones.
  getPendingTodos(userId: number) {
    const { api } = this;

    return Result.gen(async function* () {
      const user = yield* Result.await(api.getUser({ params: { id: userId } }));
      const todos = yield* Result.await(api.getTodos());

      const pending = todos.filter(
        (t) => t.userId === user.id && !t.completed,
      );

      return Result.ok({ user, pending });
    });
  }
}

// ─── Usage ────────────────────────────────────────────────────────────────────

const blog = new BlogService("https://jsonplaceholder.typicode.com");

console.log("1. Fetching enriched post #1\n");

const enriched = await blog.getEnrichedPost(1);

enriched.match({
  ok: ({ post, comments, author }) => {
    console.log(`  "${post.title}"`);
    console.log(`  by ${author.name} <${author.email}>`);
    console.log(`  ${comments.length} comments\n`);
  },
  err: (error) => console.error("  ✗", error._tag, error.message, "\n"),
});

console.log("2. Fetching pending todos for user #1\n");

const pending = await blog.getPendingTodos(1);

pending.match({
  ok: ({ user, pending: todos }) => {
    console.log(`  ${user.name} has ${todos.length} pending todos:`);
    for (const todo of todos.slice(0, 3)) {
      console.log(`    [ ] ${todo.title}`);
    }
    if (todos.length > 3) console.log(`    ... and ${todos.length - 3} more`);
    console.log();
  },
  err: (error) => console.error("  ✗", error._tag, error.message, "\n"),
});
