import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { nanoid } from "nanoid";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: number;
  }
}

const REDACTED = "[REDACTED]";

function redactSecrets(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactSecrets);

  const redacted = { ...obj };
  if ("authorization" in redacted) {
    redacted.authorization = REDACTED;
  }
  if ("token" in redacted) {
    redacted.token = REDACTED;
  }
  if ("secret" in redacted) {
    redacted.secret = REDACTED;
  }
  if ("password" in redacted) {
    redacted.password = REDACTED;
  }
  if ("privateKey" in redacted) {
    redacted.privateKey = REDACTED;
  }

  return redacted;
}

export default async function loggingPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    if (!req.id) {
      req.id = `req-${nanoid(16)}`;
    }
    req.startTime = Date.now();
    req.log = req.log.child({ reqId: req.id });
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const duration = Date.now() - (req.startTime ?? Date.now());
    req.log.info({
      requestId: req.id,
      method: req.method,
      path: req.url,
      statusCode: reply.statusCode,
      duration: `${duration}ms`,
      headers: redactSecrets(req.headers),
    });
  });
}
