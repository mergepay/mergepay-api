import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { nanoid } from "nanoid";

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
    req.id = nanoid(16);
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const duration = Date.now() - (req.startTime as number);
    app.log.info({
      requestId: req.id,
      method: req.method,
      path: req.url,
      statusCode: reply.statusCode,
      duration: `${duration}ms`,
      headers: redactSecrets(req.headers),
    });
  });
}
