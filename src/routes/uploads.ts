import { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";

const ALLOWED: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

export default async function uploadRoutes(app: FastifyInstance) {
  app.post(
    "/uploads/receipt",
    { preHandler: [app.authenticate] },
    async (req) => {
      requireUser(req);
      const data = await (req as any).file();
      if (!data) throw Errors.badRequest("no_file", "No file provided");

      const ext = ALLOWED[data.mimetype];
      if (!ext) {
        data.file.resume();
        throw Errors.badRequest(
          "bad_file_type",
          "Only PNG, JPEG, WEBP, GIF, or PDF are allowed"
        );
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (error: any) {
        if (error?.code === "FST_REQ_FILE_TOO_LARGE") {
          throw Errors.badRequest(
            "file_too_large",
            `Files must be under ${Math.floor(config.MULTIPART_FILE_SIZE_BYTES / (1024 * 1024))} MB`
          );
        }
        throw Errors.badRequest("bad_file_type", "Failed to read uploaded file");
      }
      if (buffer.length > config.MULTIPART_FILE_SIZE_BYTES) {
        throw Errors.badRequest(
          "file_too_large",
          `Files must be under ${Math.floor(config.MULTIPART_FILE_SIZE_BYTES / (1024 * 1024))} MB`
        );
      }

      const dir = path.resolve(config.UPLOADS_DIR);
      await fs.mkdir(dir, { recursive: true });
      const id = randomUUID();
      const filename = `${id}.${ext}`;
      await fs.writeFile(path.join(dir, filename), buffer);

      return {
        id,
        url: `${config.API_PUBLIC_URL}/uploads/${filename}`,
      };
    }
  );
}
