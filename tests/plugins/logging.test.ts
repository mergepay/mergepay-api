/**
 * The response-logging plugin writes the request's headers and URL itself,
 * outside Pino's `req` serializer. That direct copy is exactly where a
 * credential leaks: a hand-rolled redaction that knows `authorization` but not
 * `cookie`, `proxy-authorization`, or `x-api-key`, and that logs the raw query
 * string, puts the very secrets the serializers scrub back into the log.
 *
 * The plugin is exercised in isolation — its hooks captured from a stub app and
 * invoked directly — because that is the only way to reach them without
 * depending on how the plugin happens to be encapsulated at its registration
 * site.
 */
import { describe, it, expect, vi } from "vitest";
import loggingPlugin from "../../src/plugins/logging";

type Hook = (request: any, reply?: any) => unknown;

function stubApp() {
  const hooks: Record<string, Hook> = {};
  return {
    hooks,
    addHook(name: string, handler: Hook) {
      hooks[name] = handler;
    },
  };
}

const SECRETS = {
  authorization: "Bearer header-secret-value",
  cookie: "session=cookie-secret-value",
  "proxy-authorization": "Basic proxy-secret-value",
  "x-api-key": "api-key-secret-value",
  query: "query-secret-value",
};

describe("loggingPlugin credential redaction", () => {
  it("redacts every credential header and the URL's query string", async () => {
    const app = stubApp();
    await loggingPlugin(app as any);

    const info = vi.fn();
    const request: any = {
      id: "req-logging-test",
      method: "POST",
      url: `/api/v1/groups?access_token=${SECRETS.query}&page=1`,
      headers: {
        authorization: SECRETS.authorization,
        cookie: SECRETS.cookie,
        "proxy-authorization": SECRETS["proxy-authorization"],
        "x-api-key": SECRETS["x-api-key"],
        "user-agent": "mergepay-tests/1.0",
      },
      log: { child: () => ({ info }) },
    };

    await app.hooks.onRequest(request);
    await app.hooks.onResponse(request, { statusCode: 200 });

    expect(info).toHaveBeenCalledTimes(1);
    const payload = info.mock.calls[0][0] as Record<string, any>;

    expect(payload.headers.authorization).toBe("[REDACTED]");
    expect(payload.headers.cookie).toBe("[REDACTED]");
    expect(payload.headers["proxy-authorization"]).toBe("[REDACTED]");
    expect(payload.headers["x-api-key"]).toBe("[REDACTED]");
    // Non-sensitive context survives: the line stays useful.
    expect(payload.headers["user-agent"]).toBe("mergepay-tests/1.0");
    expect(payload.method).toBe("POST");
    expect(payload.statusCode).toBe(200);
    expect(payload.path).toBe("/api/v1/groups?access_token=[REDACTED]&page=1");

    const output = JSON.stringify(payload);
    for (const secret of Object.values(SECRETS)) {
      expect(output, `leaked ${secret}`).not.toContain(secret);
    }
  });
});
