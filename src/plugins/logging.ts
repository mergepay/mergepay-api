import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { nanoid } from "nanoid";
import { reqSerializer } from "../lib/serializers";

declare module "fastify" {
  interface FastifyRequest {
    startTime?: number;
  }
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
    // The request is serialized through the shared serializer rather than
    // logged field by field: a local header copy redacted only `authorization`
    // and missed `cookie`, `proxy-authorization`, `x-api-key`, and any
    // credential the URL's query string carried under a field name this file
    // never enumerates. See src/lib/serializers.ts.
    const serialized = reqSerializer(req);
    req.log.info({
      requestId: req.id,
      method: req.method,
      path: serialized.url,
      statusCode: reply.statusCode,
      duration: `${duration}ms`,
      headers: serialized.headers,
    });
  });
}
