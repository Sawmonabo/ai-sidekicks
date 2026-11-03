// The SHA-256 digest as the wire writes it, which several contract modules share. Internal: the
// package's exports map closes `internal/*`.
import { z } from "zod";

/** A SHA-256 written as 64 lowercase hex digits. */
export const Sha256HexSchema: z.ZodType<string, string> = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, { message: "A SHA-256 is 64 lowercase hex digits." });
