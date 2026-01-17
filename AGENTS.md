# Agent Development Guide

This guide provides essential information for AI coding agents working in this codebase.

## Quick Reference

**Runtime**: Bun (not Node.js, npm, or vite)  
**Package Manager**: `bun install`  
**Test Framework**: Bun's built-in test runner  
**Linter**: oxlint (via Ultracite)  
**Formatter**: oxfmt (via Ultracite)  
**Type Checker**: TypeScript (strict mode)

## Build, Lint, and Test Commands

### Linting and Formatting

```bash
bun run check              # Run linter without fixing
bun run fix                # Run linter and auto-fix issues
bunx ultracite doctor      # Verify Ultracite setup
```

### Testing

```bash
bun test                                    # Run all tests
bun test --test-name-pattern <pattern>      # Run specific tests
bun test --coverage                         # Run with coverage
bun test --only-failures                    # Run only failed tests
bun test --timeout=<ms>                     # Set timeout (default: 5000ms)
```

**Single Test Example**:

```bash
bun test --test-name-pattern "should fetch user"
```

### Running Examples

```bash
bun run examples/todos/index.ts            # Run todos example
```

### Project Commands

```bash
bun install                # Install dependencies
bun <file.ts>              # Run TypeScript file directly
bun run <script>           # Run package.json script
bunx <package> <command>   # Execute package command
```

## Code Style Guidelines

### Import Organization

1. **External imports first**, then internal imports after a blank line
2. **Inline type imports**: `import { type Foo } from "bar"`
3. **Destructured imports** preferred over namespace imports
4. **Automatic sorting** by oxfmt (case-insensitive, ascending)

```typescript
// External dependencies
import { err, ok, ResultAsync, safeTry } from "neverthrow";
import { z } from "zod";

// Internal modules
import { ApiError, FetchError } from "./errors";
import * as S from "./schema";
```

### Formatting Rules

- **Print width**: 80 characters
- **Indentation**: 2 spaces (no tabs)
- **Semicolons**: Required
- **Quotes**: Double quotes (not single)
- **Trailing commas**: ES5 style
- **Arrow function parens**: Always use parentheses
- **Line endings**: LF

### Naming Conventions

- **Variables/Functions**: `camelCase` (e.g., `createApi`, `buildUrl`)
- **Types/Interfaces**: `PascalCase` (e.g., `ApiClient`, `Endpoint`)
- **Classes**: `PascalCase` (e.g., `ApiError`, `FetchError`)
- **Schema variables**: `camelCase` + "Schema" (e.g., `todoSchema`)
- **Constants**: `UPPER_SNAKE_CASE` (when applicable)
- **No underscore prefixes**: Use TypeScript access modifiers instead

### Function Style

- **Arrow functions** for most cases: `const foo = () => {...}`
- **Traditional functions** for generators: `async function* gen() {...}`
- **Expression style** preferred over declarations
- **Early returns** for error/edge cases

```typescript
// Preferred
const buildUrl = ({ base, path }: Options) => {
  if (!path) return base;
  return `${base}/${path}`;
};

// Avoid traditional function declarations
function buildUrl(options: Options) { ... }
```

### Type Annotations

- **Explicit types** on function parameters for clarity
- **Return types** often inferred (explicit when complex)
- **Generic constraints** used extensively
- **Readonly properties** for immutability
- **Prefer `unknown` over `any`**

```typescript
// Good
const fetchData = async (url: string): Promise<Result<Data, ApiError>> => {
  // ...
};

// Readonly properties
type Config = {
  readonly baseUrl: string;
  readonly timeout: number;
};
```

### Error Handling

**Primary Pattern**: Functional error handling with `neverthrow` (not try-catch)

1. **ResultAsync for async operations**:

```typescript
const result = await api.getTodo({ params: { id: 1 } });

if (result.isOk()) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

2. **safeTry for generator-based error propagation**:

```typescript
return safeTry(async function* () {
  const user = yield* await api.getUser({ params: { id } });
  const posts = yield* await api.getPosts({ params: { userId: user.id } });
  return ok({ user, posts });
});
```

3. **Tagged errors for discrimination**:

```typescript
class ApiError extends TaggedError("ApiError")<{
  readonly statusCode: number;
  readonly text: string;
}> {}
```

4. **Error matching**:

```typescript
result.match(
  (data) => console.log("Success:", data),
  (error) => {
    switch (error._tag) {
      case "ApiError":
        console.error("API error:", error.statusCode);
        break;
      case "InputValidationError":
        console.error("Validation failed:", error.zodError);
        break;
    }
  }
);
```

### Modern JavaScript/TypeScript

- **const by default**, `let` when reassignment needed, never `var`
- **Arrow functions** for callbacks
- **Optional chaining**: `obj?.prop` and nullish coalescing `??`
- **Template literals** over string concatenation
- **Destructuring** assignments
- **for...of loops** over `.forEach()` when possible
- **async/await** over promise chains

### TypeScript Patterns

- **Strict mode enabled** (all strict checks on)
- **Discriminated unions** with `_tag` field
- **Conditional types** for complex type logic
- **Mapped types** for transformations
- **Zod schemas** for runtime validation
- **Const assertions** for literal types when needed

```typescript
// Discriminated union
type Result = { _tag: "success"; data: Data } | { _tag: "error"; error: Error };

// Conditional type
type EndpointReturn<E> = E extends { stream: true }
  ? ReadableStream<string>
  : E["output"];
```

### Code Organization

- **Keep functions focused** on single responsibilities
- **Extract complex conditions** to named booleans
- **Early returns** to reduce nesting
- **Small, focused files** (typically < 500 lines)
- **Clear separation of concerns** (schemas, errors, logic)

### Bun-Specific Patterns

- Use `Bun.serve()` for HTTP servers (not Express)
- Use `bun:sqlite` for SQLite (not better-sqlite3)
- Use `Bun.file()` for file operations (not fs.readFile/writeFile)
- Use built-in `WebSocket` (not ws package)
- HTML imports for frontend (not vite)
- `.env` loaded automatically (no dotenv package needed)

### Testing Patterns

```typescript
import { test, expect } from "bun:test";

test("should validate user input", () => {
  const result = userSchema.safeParse({ name: "John" });
  expect(result.success).toBe(true);
});

test("should handle async operations", async () => {
  const data = await fetchData();
  expect(data).toBeDefined();
});
```

- **Assertions inside `it()` or `test()` blocks**
- **async/await** instead of done callbacks
- **Don't commit `.only` or `.skip`** in production code
- **Keep test suites reasonably flat**

### Linter Overrides

Use inline comments when necessary (sparingly):

```typescript
// oxlint-disable-next-line no-explicit-any
const data: any = JSON.parse(text);
```

## Security & Best Practices

- Add `rel="noopener"` with `target="_blank"` links
- Avoid `eval()` or `Function()` constructors
- Validate and sanitize all external input
- Remove `console.log`, `debugger`, `alert` in production
- Throw Error objects with descriptive messages

## Automated Formatting

Files are automatically formatted after:

- **File edits** in Cursor IDE
- **Write/Edit operations** by Claude
- Running `bun run fix`

The formatter runs `bun x ultracite fix` which applies oxfmt formatting rules.
