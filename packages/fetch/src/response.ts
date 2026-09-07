import { Result } from "better-result";

import { ApiError, ParseError, ValidationError } from "./errors";
import { validateSchema } from "./schema";
import type { OkfetchOptions } from "./types";

export const shouldValidateErrorResponse = (
  options: OkfetchOptions,
  statusCode: number
): boolean =>
  options.apiErrorDataSchema !== undefined &&
  (options.shouldValidateError?.(statusCode) ?? true);

export const readResponseText = async (
  response: Response
): Promise<Result<string, ParseError>> =>
  Result.tryPromise({
    catch: (error) =>
      new ParseError({
        cause: error,
        message: "Failed to read response body as text",
      }),
    try: () => response.text(),
  });

export const createApiError = async <TErr>(
  response: Response,
  text: string,
  options: OkfetchOptions
): Promise<ApiError<TErr>> => {
  const errorDataSchema = options.apiErrorDataSchema;
  const responseDetails = options.includeResponse ? { response } : {};
  const baseError = new ApiError<TErr>({
    ...responseDetails,
    statusCode: response.status,
    statusText: response.statusText,
    text,
  });

  if (errorDataSchema === undefined) {
    return baseError;
  }

  const apiErrorDataResult = Result.try({
    catch: (error) => error,
    try: () => JSON.parse(text),
  });
  if (apiErrorDataResult.isErr()) {
    return baseError;
  }

  if (!shouldValidateErrorResponse(options, response.status)) {
    return new ApiError<TErr>({
      data: apiErrorDataResult.value as TErr,
      ...responseDetails,
      statusCode: response.status,
      statusText: response.statusText,
      text,
    });
  }

  const parsedApiErrorData = await validateSchema(
    errorDataSchema,
    apiErrorDataResult.value
  );

  // On validation failure keep the raw parsed body rather than dropping it
  return new ApiError<TErr>({
    data: (parsedApiErrorData.success
      ? parsedApiErrorData.data
      : apiErrorDataResult.value) as TErr,
    ...responseDetails,
    statusCode: response.status,
    statusText: response.statusText,
    text,
  });
};

export const parseResponseData = async <TRes>(
  text: string,
  options: OkfetchOptions
): Promise<Result<TRes, ParseError | ValidationError>> => {
  const dataResult = Result.try({
    catch: (error) =>
      new ParseError({
        cause: error,
        message: "Failed to parse response body as JSON",
      }),
    try: () => JSON.parse(text),
  });
  if (dataResult.isErr()) {
    return dataResult;
  }

  if (!options.outputSchema || options.validateOutput === false) {
    return Result.ok(dataResult.value as TRes);
  }

  const parsedData = await validateSchema(
    options.outputSchema,
    dataResult.value
  );
  if (!parsedData.success) {
    return Result.err(
      new ValidationError({
        issues: parsedData.issues,
        message: "Response body did not match output schema",
        type: "output",
      })
    );
  }

  return Result.ok(parsedData.data as TRes);
};
