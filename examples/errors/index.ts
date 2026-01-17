// oxlint-disable require-hook
// oxlint-disable max-statements
// oxlint-disable unicorn/no-useless-switch-case
// oxlint-disable prefer-await-to-callbacks
import {
  createApi,
  createEndpoints,
  validateAllErrors,
  validateClientErrors,
} from "kanonic";
import { z } from "zod";

// Define the error response schema
const apiErrorSchema = z.object({
  code: z.string(),
  details: z.record(z.unknown()).optional(),
  message: z.string(),
});

// Define a user schema for the success case
const userSchema = z.object({
  email: z.string(),
  id: z.number(),
  name: z.string(),
});

// Create endpoints
const endpoints = createEndpoints({
  createUser: {
    input: z.object({
      email: z.string().email(),
      name: z.string(),
    }),
    method: "POST",
    output: userSchema,
    path: "/users",
  },
  getUser: {
    method: "GET",
    output: userSchema,
    params: z.object({
      id: z.number(),
    }),
    path: "/users/:id",
  },
});

// Example 1: API with typed errors (default validation - only 4xx)
console.log("Example 1: Default error validation (4xx only)");
const apiWithDefaultValidation = createApi({
  baseUrl: "https://jsonplaceholder.typicode.com",
  endpoints,
  errorSchema: apiErrorSchema,
});

// Example 2: API that validates all errors
console.log("\nExample 2: Validate all errors (4xx and 5xx)");
const _apiWithAllErrors = createApi({
  baseUrl: "https://jsonplaceholder.typicode.com",
  endpoints,
  errorSchema: apiErrorSchema,
  shouldValidateError: validateAllErrors,
});

// Example 3: API with custom validation logic
console.log("\nExample 3: Custom validation (only 400 and 422)");
const _apiWithCustomValidation = createApi({
  baseUrl: "https://jsonplaceholder.typicode.com",
  endpoints,
  errorSchema: apiErrorSchema,
  shouldValidateError: (statusCode: number) =>
    statusCode === 400 || statusCode === 422,
});

// Example 4: Using validateClientErrors preset
console.log("\nExample 4: Using validateClientErrors preset");
const _apiWithClientErrors = createApi({
  baseUrl: "https://jsonplaceholder.typicode.com",
  endpoints,
  errorSchema: apiErrorSchema,
  shouldValidateError: validateClientErrors,
});

// Example 5: No error schema (backward compatible)
console.log("\nExample 5: No error schema (backward compatible)");
const _apiWithoutErrorSchema = createApi({
  baseUrl: "https://jsonplaceholder.typicode.com",
  endpoints,
});

// Demonstrate error handling with typed errors
const demonstrateErrorHandling = async () => {
  console.log("\n--- Demonstrating Type-Safe Error Handling ---\n");

  // Try to get a non-existent user (will return 404)
  const result = await apiWithDefaultValidation.getUser({
    params: { id: 99_999 },
  });

  result.match(
    (user) => {
      console.log("Success:", user);
    },
    (error) => {
      switch (error._tag) {
        case "ApiError": {
          console.log("API Error occurred:");
          console.log("  Status Code:", error.statusCode);

          // error.data is typed as ApiErrorData | undefined
          if (error.data) {
            // Type-safe access to structured error
            console.log("  Error Code:", error.data.code);
            console.log("  Error Message:", error.data.message);
            if (error.data.details) {
              console.log("  Details:", error.data.details);
            }
          } else {
            // Fallback to raw text when parsing/validation fails
            console.log("  Raw Error Text:", error.text);
          }
          break;
        }
        case "FetchError": {
          console.log("Network Error:", error.message);
          break;
        }
        case "InputValidationError": {
          console.log("Invalid Input:", error.message);
          console.log("Validation Errors:", error.zodError.issues);
          break;
        }
        case "OutputValidationError": {
          console.log("Invalid Output:", error.message);
          console.log("Validation Errors:", error.zodError.issues);
          break;
        }
        case "ParseError": {
          console.log("Parse Error:", error.message);
          break;
        }
        default: {
          console.log("Unknown error:", error);
          break;
        }
      }
    }
  );
};

// Demonstrate different validation strategies
const demonstrateValidationStrategies = () => {
  console.log("\n--- Validation Strategies ---\n");

  console.log("1. Default (4xx only):");
  console.log("   - 400-499: ✓ Validates and parses error.data");
  console.log("   - 500-599: ✗ Returns raw error.text only\n");

  console.log("2. validateAllErrors:");
  console.log("   - All errors: ✓ Validates and parses error.data\n");

  console.log("3. validateClientErrors:");
  console.log("   - Same as default (4xx only)\n");

  console.log("4. Custom function:");
  console.log("   - Define your own logic");
  console.log("   - Example: (code) => code === 400 || code === 422\n");

  console.log("5. No error schema:");
  console.log("   - Backward compatible behavior");
  console.log("   - Always returns raw error.text\n");
};

// Run demonstrations
demonstrateValidationStrategies();
await demonstrateErrorHandling();

console.log("\n--- Benefits of Typed Errors ---\n");
console.log("✓ Type-safe error handling with TypeScript");
console.log("✓ Structured error data when available");
console.log("✓ Graceful fallback to raw text on parse/validation failure");
console.log("✓ Flexible validation control per status code");
console.log("✓ Backward compatible with existing code");
console.log("✓ Consistent with input/output validation\n");
