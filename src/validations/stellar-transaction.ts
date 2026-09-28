/** Request validation for signed Stellar transaction submission. */
import { z } from "zod";
import { isValidXdr } from "../utils/stellar-xdr";

const signedXdrSchema = z
  .string()
  .min(1, "Signed transaction XDR is required")
  .max(50000, "Signed transaction XDR exceeds maximum size")
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "Signed transaction must be base64-encoded XDR"
  )
  .refine(
    (value) => Buffer.from(value, "base64").toString("base64") === value,
    "Signed transaction must use canonical base64 encoding"
  )
  // Shared parse-level XDR check (issue #419): rejects anything the SDK
  // cannot decode, before a handler ever touches the envelope.
  .refine(
    (value) => isValidXdr(value),
    "Signed transaction must be valid Stellar transaction XDR"
  );

export const signedXdrRequestSchema = z.object({ signedXdr: signedXdrSchema });

export type SignedXdrRequest = z.infer<typeof signedXdrRequestSchema>;