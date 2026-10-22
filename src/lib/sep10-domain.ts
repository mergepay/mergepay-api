/**
 * The domain grammar SEP-10 endpoints accept.
 *
 * One definition, used both by the request schema (`src/validations/sep10.ts`)
 * and by boot-time configuration (`src/config.ts`), because the two must agree:
 * `/auth/verify` compares a client's `home_domain` against
 * `config.SEP10_HOME_DOMAIN` and names that domain in the error it returns when
 * they differ. When the request grammar and the configured value disagreed, a
 * client that obeyed the error message was rejected for the *shape* of a domain
 * the server had just told it to send.
 *
 * `config.SEP10_HOME_DOMAIN` defaults to `new URL(API_PUBLIC_URL).host`, which
 * keeps the port and, in local and container development, is often a single
 * label — `localhost:4000` is the fallback baked into `hostOf` itself. A
 * grammar that required a dot and forbade a port therefore could not express the
 * domains this server actually issues challenges for.
 *
 * What is still refused, deliberately:
 *
 *  - anything that is not a hostname — a URL (`http://example.com`), an IP with
 *    a CIDR or a zone, or an IPv6 literal (SEP-10 home domains are hostnames,
 *    and `stellar.toml` is looked up by name);
 *  - underscores, empty labels, and labels that start or end with a hyphen;
 *  - a port outside 1-65535;
 *  - more than `MAX_SEP10_DOMAIN_LENGTH` characters, the DNS limit.
 *
 * Accepting a port is not a weakening: this value only ever has to equal the
 * server's own configured domain, and signature verification binds the
 * challenge to it, so a client cannot use the port to authenticate some other
 * home domain.
 */

import { z } from "zod";

/** The DNS limit on a fully-qualified name, which SEP-10 home domains obey. */
export const MAX_SEP10_DOMAIN_LENGTH = 253;

/** RFC 1123 label: 1-63 characters, alphanumerics and inner hyphens. */
const LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const MAX_LABEL_LENGTH = 63;
const MAX_PORT = 65535;

/** Whether every label of an IPv4-dotted host is a 0-255 octet. */
function isIpv4(host: string): boolean {
  const labels = host.split(".");
  return (
    labels.length === 4 &&
    labels.every(
      (label) => /^\d{1,3}$/.test(label) && Number(label) >= 0 && Number(label) <= 255
    )
  );
}

/**
 * Whether `value` is a hostname a SEP-10 home domain (or web auth domain) can
 * legitimately be, optionally suffixed with `:port`.
 */
export function isSep10Domain(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SEP10_DOMAIN_LENGTH) return false;

  let host = value;
  const colon = value.lastIndexOf(":");
  if (colon !== -1) {
    const port = value.slice(colon + 1);
    host = value.slice(0, colon);
    if (!/^\d+$/.test(port)) return false;
    const asNumber = Number(port);
    if (asNumber < 1 || asNumber > MAX_PORT) return false;
  }

  if (host.length === 0) return false;
  // A URL, a path, or userinfo: none of these are hostnames.
  if (host.includes("/") || host.includes("@") || host.includes("[")) return false;

  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > MAX_LABEL_LENGTH)) {
    return false;
  }
  if (labels.some((label) => !LABEL.test(label))) return false;

  // A single-label host (`localhost`, a container name) is a valid SEP-10 home
  // domain for a local deployment. A multi-label host must end in either a
  // real TLD or a complete IPv4 address.
  if (labels.length === 1) return true;
  const final = labels[labels.length - 1];
  if (/^\d+$/.test(final)) return isIpv4(host);
  return /^[a-zA-Z]{2,}$/.test(final);
}

/** The Zod form of {@link isSep10Domain}, shared by config and request schemas. */
export const sep10DomainSchema = z
  .string()
  .min(1, "Domain cannot be empty when provided")
  .max(MAX_SEP10_DOMAIN_LENGTH, "Domain exceeds maximum length")
  .refine(isSep10Domain, "Domain must be a hostname, optionally with a port");

/**
 * The stricter grammar a SEP-10 `client_domain` must obey: a fully-qualified
 * name with a real alphabetic TLD, no port and no single-label host.
 *
 * `home_domain` is *this* server's domain and legitimately carries a port and a
 * single label in local and container development (`localhost:4000`), so it uses
 * {@link sep10DomainSchema}. `client_domain` is different in kind: it names the
 * origin the client app's `stellar.toml` is fetched from, so it must be a public
 * resolvable host — a bare label like `example` or a `host:port` has no `stellar.toml`
 * to read and is rejected. This mirrors the grammar main already enforced for this
 * field; only the home-domain check was loosened, and only as far as the server's
 * own configured domain requires.
 */
export const clientDomainSchema = z
  .string()
  .min(1, "Domain cannot be empty when provided")
  .max(MAX_SEP10_DOMAIN_LENGTH, "Domain exceeds maximum length")
  .regex(
    /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    "Domain must be a valid domain name"
  );
