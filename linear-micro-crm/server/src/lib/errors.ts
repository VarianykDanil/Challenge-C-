export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const conflict = (message: string) => new HttpError(409, message);
export const tooManyRequests = (message: string) => new HttpError(429, message);
export const gone = (message: string) => new HttpError(410, message);
