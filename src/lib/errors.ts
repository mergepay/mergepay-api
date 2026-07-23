/** Application error with a stable machine code + HTTP status. */
export class AppError extends Error {
  status: number;
  /** Mirror of `status` so Fastify's default handler also returns the right code. */
  statusCode: number;
  code: string;
  details?: any;

  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  unauthorized: (msg = "Authentication required") =>
    new AppError(401, "UNAUTHORIZED", msg),
  forbidden: (msg = "You do not have access to this resource") =>
    new AppError(403, "FORBIDDEN", msg),
  notFound: (msg = "Not found") => new AppError(404, "NOT_FOUND", msg),
  badRequest: (code: string, msg: string, details?: any) =>
    new AppError(400, code, msg, details),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
  upstream: (msg: string) => new AppError(502, "UPSTREAM_ERROR", msg),
};
