/**
 * Receipt uploads — the only multipart route in the API.
 *
 * The file is streamed to disk rather than buffered: `toBuffer()` holds the
 * whole upload in memory before anything can inspect its size, so a burst of
 * concurrent uploads is a memory cost proportional to their total size. Piping
 * to a temporary file keeps the resident cost to one stream buffer per request,
 * and @fastify/multipart's own `fileSize` limit stops the stream at the
 * configured ceiling regardless of what the client claimed.
 *
 * Nothing partial survives a rejection. The upload lands under a temporary name
 * and is renamed into place only once it has been fully received and accepted;
 * every failure path removes it. A client that aborts mid-upload therefore
 * leaves no half-written receipt behind, and no URL is ever returned for a file
 * that is not complete.
 *
 * Limits and their client-visible errors live in src/lib/request-limits.ts.
 * Filenames and file contents are never logged.
 */
import { FastifyInstance } from "fastify";
import { promises as fs, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
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

/** Remove a partial upload, ignoring the case where it was never created. */
async function discard(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch(() => undefined);
}

/**
 * Reject a request carrying a form field that busboy truncated at `fieldSize`.
 *
 * @fastify/multipart raises for too *many* fields but not for one that is too
 * large — an oversized value arrives silently shortened, flagged only by
 * `valueTruncated`. Accepting that would mean acting on data the client did not
 * send. The field's name is used but its value never is.
 */
function assertNoTruncatedField(fields: unknown): void {
  if (!fields || typeof fields !== "object") return;
  for (const field of Object.values(fields as Record<string, unknown>)) {
    for (const part of Array.isArray(field) ? field : [field]) {
      if (part && typeof part === "object" && (part as any).valueTruncated) {
        throw Errors.badRequest(
          "field_too_large",
          `A form field is too large. Fields must be under ${Math.floor(
            config.MULTIPART_FIELD_SIZE_BYTES / 1024
          )} KB.`
        );
      }
    }
  }
}

export default async function uploadRoutes(app: FastifyInstance) {
  app.post(
    "/uploads/receipt",
    { preHandler: [app.authenticate] },
    async (req) => {
      requireUser(req);

      // Limit violations (file too large, too many files, oversized field) are
      // raised here by @fastify/multipart and mapped to their own client errors
      // by the central error handler — see src/lib/request-limits.ts.
      const data = await (req as any).file();
      if (!data) throw Errors.badRequest("no_file", "No file provided");

      // A malformed body makes busboy's parser emit a late 'error' on the part
      // stream, after this handler has already answered. `pipeline` removes its
      // own listeners once it settles, so that emit would otherwise land on a
      // stream with no listener — an uncaught exception in Node. The listener
      // is never removed, so the late error is absorbed while the client still
      // receives the 4xx produced below. Deliberately not logged: the parser's
      // message can quote the malformed body back.
      data.file.on("error", () => undefined);

      // busboy enforces `fieldSize` by silently truncating an oversized field
      // rather than raising: only `fieldsLimit` (too many fields) throws. A
      // truncated field would otherwise be accepted as though it were complete,
      // so the request is rejected explicitly instead.
      assertNoTruncatedField(data.fields);

      const ext = ALLOWED[data.mimetype];
      if (!ext) {
        // Drain the stream so the connection is not left half-read while the
        // client is still sending.
        data.file.resume();
        throw Errors.badRequest(
          "bad_file_type",
          "Only PNG, JPEG, WEBP, GIF, or PDF are allowed"
        );
      }

      const dir = path.resolve(config.UPLOADS_DIR);
      // Partial uploads are staged *outside* the directory @fastify/static
      // serves, as a sibling rather than a child. A ".part" file inside the
      // served root would be publicly fetchable while it was still being
      // written — @fastify/static's `dotfiles` option defaults to "allow", so
      // a leading dot is not protection.
      const tempDir = `${dir}.incoming`;
      // Both are created up front: the rename below moves between them, and a
      // missing destination would fail an upload that had already succeeded.
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(tempDir, { recursive: true });

      const id = randomUUID();
      const filename = `${id}.${ext}`;
      const finalPath = path.join(dir, filename);
      const tempPath = path.join(tempDir, `${id}.part`);

      try {
        await pipeline(data.file, createWriteStream(tempPath));
      } catch (error: any) {
        await discard(tempPath);
        if (error?.code === "FST_REQ_FILE_TOO_LARGE") throw error;
        throw Errors.badRequest("bad_file_type", "Failed to read uploaded file");
      }

      // `truncated` is set when the stream hit the configured fileSize limit.
      // Checked even with throwFileSizeLimit on, so a truncated upload can
      // never be renamed into place by a future change to that option.
      if (data.file.truncated) {
        await discard(tempPath);
        throw Errors.badRequest(
          "file_too_large",
          `Files must be under ${Math.floor(
            config.MULTIPART_FILE_SIZE_BYTES / (1024 * 1024)
          )} MB`
        );
      }

      try {
        await fs.rename(tempPath, finalPath);
      } catch {
        await discard(tempPath);
        throw Errors.internal("Failed to store the uploaded file");
      }

      return {
        id,
        url: `${config.API_PUBLIC_URL}/uploads/${filename}`,
      };
    }
  );
}
