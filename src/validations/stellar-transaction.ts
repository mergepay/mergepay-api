/** Request validation for signed Stellar transaction submission. */
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";

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
  .refine((value) => {
    try {
      TransactionBuilder.fromXDR(value, config.networkPassphrase);
      return true;
    } catch {
      return false;
    }
  }, "Signed transaction must be valid Stellar transaction XDR");

export const signedXdrRequestSchema = z.object({ signedXdr: signedXdrSchema });

export type SignedXdrRequest = z.infer<typeof signedXdrRequestSchema>;