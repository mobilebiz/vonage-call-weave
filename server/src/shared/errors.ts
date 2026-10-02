export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new ApiError(400, 'bad_request', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const gone = () => new ApiError(410, 'expired', 'retention period has expired');
