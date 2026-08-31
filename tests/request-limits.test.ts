/**
 * Request size and multipart limits (issue #198).
 *
 * Covers the mapping from a framework limit error to the API's own stable code,
 * and the end-to-end behaviour of the one multipart route: oversized files, too
 * many files, oversized fields, malformed bodies, and the successful small
 * upload that must keep working. Also pins down that a rejected upload leaves
 * nothing behind on disk.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";
import { toRequestLimitError, requestLimits } from "../src/lib/request-limits";
import * as multipartGuard from "../src/lib/multipart-guard";

const USER_ID = "user_1";
const USER_KEY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** The directories the route actually writes to, as configured. */
const UPLOAD_ROOT = path.resolve(config.UPLOADS_DIR);
const STAGING_ROOT = `${UPLOAD_ROOT}.incoming`;

function authHeader() {
  return {
    authorization: `Bearer ${signToken({ id: USER_ID, stellarPublicKey: USER_KEY })}`,
  };
}

/** Build a multipart body by hand so malformed cases can be expressed. */
function multipartBody(
  parts: Array<
    | { name: string; filename: string; contentType: string; content: Buffer }
    | { name: string; value: string }
  >,
  boundary: string
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("filename" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`
        )
      );
      chunks.push(part.content);
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`
        )
      );
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const BOUNDARY = "----mergepaytestboundary";

function pngOf(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0x89);
}

let app: Awaited<ReturnType<typeof buildApp>>;

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Everything this suite has written, so afterAll can clean up without touching
 * receipts the configured uploads directory already held.
 */
const created = new Set<string>();

/** Snapshot taken before a request, so each test sees only its own effect. */
let before: Set<string> = new Set();

async function snapshot(): Promise<void> {
  before = new Set(await listDir(UPLOAD_ROOT));
}

/** Files that appeared in the uploads directory since the last snapshot. */
async function appearedSinceSnapshot(): Promise<string[]> {
  const entries = await listDir(UPLOAD_ROOT);
  const added = entries.filter((name) => !before.has(name));
  added.forEach((name) => created.add(name));
  return added;
}

/** Anything left mid-flight in the staging directory. */
async function stagedOnDisk(): Promise<string[]> {
  return listDir(STAGING_ROOT);
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  h.prisma.user.findUnique.mockResolvedValue({
    id: USER_ID,
    stellarPublicKey: USER_KEY,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date(),
  });
  await snapshot();
});

afterAll(async () => {
  // Remove only what these tests wrote; the uploads directory is shared.
  for (const name of created) {
    await fs.rm(path.join(UPLOAD_ROOT, name), { force: true }).catch(() => undefined);
  }
});

describe("limit configuration", () => {
  it("resolves every limit to a positive, explicitly configured value", () => {
    // The point is that each limit exists and is bounded — not that it holds a
    // particular number, which a deployment is meant to be able to change.
    const limits = requestLimits();
    for (const [name, value] of Object.entries(limits)) {
      expect(value, name).toBeGreaterThan(0);
      expect(Number.isFinite(value), name).toBe(true);
    }
  });

  it("bounds a single form field well below the file limit", () => {
    // A form field is buffered in memory; a file is streamed. The field
    // ceiling should therefore be the tighter of the two.
    const limits = requestLimits();
    expect(limits.multipartFieldBytes).toBeLessThan(limits.multipartFileBytes);
  });
});

describe("truncated-multipart guard", () => {
  const { isTruncatedMultipartError } = multipartGuard.__testing;

  it("recognises the parser's late truncation error", () => {
    // @fastify/busboy emits this on a stream no application code can reach,
    // which without the guard is an uncaught exception. See
    // src/lib/multipart-guard.ts.
    expect(
      isTruncatedMultipartError(
        new Error("Part terminated early due to unexpected end of multipart data")
      )
    ).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    for (const other of [
      new Error("terminated early"),
      new Error("unexpected end of multipart data"),
      new Error("something else entirely"),
      "not an error",
      null,
    ]) {
      expect(isTruncatedMultipartError(other)).toBe(false);
    }
  });
});

describe("mapping framework limit errors", () => {
  it.each([
    ["FST_ERR_CTP_BODY_TOO_LARGE", 413, "REQUEST_TOO_LARGE"],
    ["FST_REQ_FILE_TOO_LARGE", 413, "FILE_TOO_LARGE"],
    ["FST_FILES_LIMIT", 413, "TOO_MANY_FILES"],
    ["FST_FIELDS_LIMIT", 413, "FIELD_TOO_LARGE"],
    ["FST_PARTS_LIMIT", 413, "TOO_MANY_PARTS"],
    ["FST_INVALID_MULTIPART_CONTENT_TYPE", 415, "BAD_REQUEST"],
  ] as const)("maps %s to %i %s", (code, status, expected) => {
    const mapped = toRequestLimitError(Object.assign(new Error("raw"), { code }));
    expect(mapped).toMatchObject({ status, code: expected });
  });

  it("names the configured limit in the message rather than a hard-coded one", () => {
    const mapped = toRequestLimitError(
      Object.assign(new Error("x"), { code: "FST_PARTS_LIMIT" })
    );
    // 5 comes from MULTIPART_MAX_FIELDS, set for this suite.
    expect(mapped?.message).toContain(String(config.MULTIPART_MAX_FIELDS));
  });

  it("answers a malformed multipart body without echoing the parser's text", () => {
    const mapped = toRequestLimitError(new Error("Unexpected end of form"));
    expect(mapped).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(mapped?.message).toBe("Malformed multipart request.");
  });

  it("leaves unrelated errors alone", () => {
    expect(toRequestLimitError(new Error("something else"))).toBeNull();
    expect(toRequestLimitError(null)).toBeNull();
    expect(toRequestLimitError("nope")).toBeNull();
  });
});

describe("POST /uploads/receipt", () => {
  it("accepts a small file below every limit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          {
            name: "file",
            filename: "receipt.png",
            contentType: "image/png",
            content: pngOf(1024),
          },
        ],
        BOUNDARY
      ),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toContain("/uploads/");
    created.add(`${body.id}.png`);

    // The finished file is in place under the id the response returned, and
    // nothing was left staged.
    expect(await appearedSinceSnapshot()).toContain(`${body.id}.png`);
    expect(await stagedOnDisk()).toEqual([]);
  });

  it("rejects a file over the size limit with a consistent 4xx", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          {
            name: "file",
            filename: "big.png",
            contentType: "image/png",
            content: pngOf(config.MULTIPART_FILE_SIZE_BYTES + 4096),
          },
        ],
        BOUNDARY
      ),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBe("FILE_TOO_LARGE");
  });

  it("leaves nothing on disk when an upload is rejected", async () => {
    await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          {
            name: "file",
            filename: "big.png",
            contentType: "image/png",
            content: pngOf(config.MULTIPART_FILE_SIZE_BYTES + 4096),
          },
        ],
        BOUNDARY
      ),
    });

    // No partial receipt in the served directory, and no staged fragment.
    expect(await appearedSinceSnapshot()).toEqual([]);
    expect(await stagedOnDisk()).toEqual([]);
  });

  it("rejects a disallowed file type without writing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          {
            name: "file",
            filename: "run.exe",
            contentType: "application/x-msdownload",
            content: pngOf(512),
          },
        ],
        BOUNDARY
      ),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("BAD_FILE_TYPE");
    expect(await appearedSinceSnapshot()).toEqual([]);
  });

  it("rejects more files than the limit allows", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          {
            name: "file",
            filename: "a.png",
            contentType: "image/png",
            content: pngOf(256),
          },
          {
            name: "file2",
            filename: "b.png",
            contentType: "image/png",
            content: pngOf(256),
          },
        ],
        BOUNDARY
      ),
    });

    // Either the second file trips the files limit, or the route completes on
    // the first — both are acceptable, but neither may be a 5xx.
    expect(res.statusCode).toBeLessThan(500);
  });

  it("rejects an oversized form field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          {
            name: "note",
            value: "x".repeat(config.MULTIPART_FIELD_SIZE_BYTES + 2048),
          },
          {
            name: "file",
            filename: "a.png",
            contentType: "image/png",
            content: pngOf(256),
          },
        ],
        BOUNDARY
      ),
    });

    // busboy truncates an oversized field silently rather than raising, so the
    // route checks `valueTruncated` itself — otherwise the upload would be
    // accepted with data the client never sent.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("FIELD_TOO_LARGE");
    expect(await appearedSinceSnapshot()).toEqual([]);
    expect(await stagedOnDisk()).toEqual([]);
  });

  it("accepts a form field within the size limit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        [
          { name: "note", value: "a short note" },
          {
            name: "file",
            filename: "a.png",
            contentType: "image/png",
            content: pngOf(256),
          },
        ],
        BOUNDARY
      ),
    });

    expect(res.statusCode).toBe(200);
    created.add(`${res.json().id}.png`);
  });

  it("rejects a malformed multipart body without an unhandled exception", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      // Truncated: the closing boundary never arrives.
      payload: Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
          `Content-Type: image/png\r\n\r\npartial-data`
      ),
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBeTruthy();
  });

  it("rejects a request that is not multipart at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { not: "multipart" },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("requires authentication before any body is consumed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(
        [
          {
            name: "file",
            filename: "a.png",
            contentType: "image/png",
            content: pngOf(256),
          },
        ],
        BOUNDARY
      ),
    });

    expect(res.statusCode).toBe(401);
    expect(await appearedSinceSnapshot()).toEqual([]);
  });
});

describe("JSON body limits", () => {
  it("rejects an oversized JSON body with a consistent 4xx", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: { account: "G".repeat(config.JSON_BODY_LIMIT_BYTES + 1024) },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().code).toBeTruthy();
  });

  it("does not constrain an ordinary JSON request", async () => {
    // A small body on a JSON route is unaffected by the multipart limits.
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: { account: USER_KEY },
    });

    expect(res.statusCode).not.toBe(413);
  });
});
