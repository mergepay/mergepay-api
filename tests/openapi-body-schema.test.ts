/**
 * `openApiBody`'s contract, and issue #519's use of it on the auth routes.
 *
 * The helper turns a Zod schema into the body schema Fastify both validates
 * against and documents. Those are two different jobs, and conflating them is
 * how a route ends up with two validators: Fastify rejecting a payload in ajv's
 * words (FST_ERR_VALIDATION, no `issues` array) before the handler's Zod parse
 * can report the message the project documents.
 *
 * `{ enforce: false }` is the opt-in that keeps the two apart — the body is
 * still documented, but the handler's Zod parse is the only thing that can
 * reject a request.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { openApiBody } from "../src/lib/openapi";
import { sep10ChallengeRequestSchema, sep10VerifyRequestSchema } from "../src/validations/sep10";

/** Collect every JSON Schema keyword present in a tree, however deeply nested. */
function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) keywords(entry, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;

  for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
    found.add(keyword);
    keywords(value, found);
  }
  return found;
}

const sample = z.object({
  name: z.string().min(1).max(40),
  code: z.string().regex(/^[A-Z]{3}$/),
  amount: z.number().int().positive().max(1000),
  tags: z.array(z.string()).max(3),
  kind: z.enum(["a", "b"]),
});

describe("openApiBody", () => {
  it("keeps the permissive overrides it has always applied", () => {
    const body = openApiBody(sample);

    expect(body).toMatchObject({ type: "object", required: [], additionalProperties: true });
  });

  it("documents the payload's shape", () => {
    const body = openApiBody(sample);
    const properties = body.properties as Record<string, Record<string, unknown>>;

    for (const field of ["name", "code", "amount", "tags", "kind"]) {
      expect(properties[field], `missing ${field} from the documented body`).toBeTruthy();
    }
  });

  describe("with enforce: false", () => {
    it("drops the keywords Fastify would enforce", () => {
      const keywords_ = keywords(openApiBody(sample, { enforce: false }));

      for (const rule of ["minLength", "maxLength", "pattern", "minimum", "maximum", "maxItems", "enum"]) {
        expect(keywords_.has(rule), `${rule} would still let Fastify reject the body`).toBe(false);
      }
    });

    it("keeps the keywords that describe the payload", () => {
      const keywords_ = keywords(openApiBody(sample, { enforce: false }));

      for (const shape of ["type", "properties", "required", "items", "additionalProperties"]) {
        expect(keywords_.has(shape), `${shape} should stay documented`).toBe(true);
      }
      expect((openApiBody(sample, { enforce: false }).properties as Record<string, any>).name).toEqual({
        type: "string",
      });
    });

    it("leaves an enforcing body schema untouched by default", () => {
      // The default is unchanged, so routes that rely on Fastify's own
      // rejection (or simply have not opted in) behave exactly as before.
      expect(keywords(openApiBody(sample)).has("pattern")).toBe(true);
      expect(keywords(openApiBody(sample)).has("minLength")).toBe(true);
      expect(openApiBody(sample)).toEqual(openApiBody(sample, {}));
    });

    it("keeps a piped field's type in the docs instead of reducing it to {}", () => {
      // `.length(56).pipe(...)` renders as an allOf of schemas; recursing into
      // the composition keeps `account` typed, where dropping the composition
      // would have left Swagger with an untyped field.
      const documented = openApiBody(sep10ChallengeRequestSchema, { enforce: false });
      const account = (documented.properties as Record<string, any>).account;

      expect(account).toEqual({ allOf: [{ type: "string" }, { type: "string" }] });
    });

    it("documents the SEP-10 verify payload without the rules that duplicate the handler", () => {
      const documented = openApiBody(sep10VerifyRequestSchema, { enforce: false });

      expect(Object.keys(documented.properties as object)).toEqual([
        "transaction",
        "home_domain",
        "client_domain",
        "clientDomain",
      ]);
      expect((documented.properties as Record<string, any>).transaction).toEqual({
        type: "string",
      });
    });
  });
});
