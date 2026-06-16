import { InvalidUserIdError, MissingUserIdError, RuntimeNotFoundError } from "../../domain/runtime/runtime-errors";

export interface HttpErrorResponse {
  readonly code: string;
  readonly message: string;
}

export function mapErrorToStatus(error: unknown): { statusCode: number; body: HttpErrorResponse } {
  if (error instanceof MissingUserIdError) {
    return {
      body: { code: "MISSING_USER_ID", message: error.message },
      statusCode: 400,
    };
  }

  if (error instanceof InvalidUserIdError) {
    return {
      body: { code: "INVALID_USER_ID", message: error.message },
      statusCode: 400,
    };
  }

  if (error instanceof RuntimeNotFoundError) {
    return {
      body: { code: "RUNTIME_NOT_FOUND", message: error.message },
      statusCode: 404,
    };
  }

  return {
    body: { code: "INTERNAL_ERROR", message: "internal server error" },
    statusCode: 500,
  };
}
