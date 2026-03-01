/**
 * Preset validation function that validates only client errors (4xx status codes).
 *
 * @example
 * ```ts
 * const api = createApi({
 *   baseUrl: "https://api.example.com",
 *   endpoints,
 *   errorSchema: apiErrorSchema,
 *   shouldValidateError: validateClientErrors
 * });
 * ```
 */
export const validateClientErrors = (statusCode: number) =>
  statusCode >= 400 && statusCode < 500;

/**
 * Preset validation function that validates all error responses (both 4xx and 5xx).
 *
 * @example
 * ```ts
 * const api = createApi({
 *   baseUrl: "https://api.example.com",
 *   endpoints,
 *   errorSchema: apiErrorSchema,
 *   shouldValidateError: validateAllErrors
 * });
 * ```
 */
export const validateAllErrors = () => true;
