// Internal helpers for the contracts package; not re-exported from `src/index.ts`.
import { z } from "zod";

// The RFC 9562 UUID text form shared by every branded UUID id, matched case-insensitively: the
// general 8-4-4-4-12 form (version nibble 1-8, variant nibble 8, 9, a or b), plus the Nil and Max
// UUIDs. It is not `z.uuid()`: that pattern spells the Nil and Max sentinels as lowercase literals
// with no `i` flag, so `FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF` would be refused while its lowercase
// spelling parses. It accepts any case and normalizes nothing; canonical casing is applied at each
// map-key or hash-input boundary (see `uuid-canonical.ts`), because ids are branded by casts at
// database reads and a schema-level lowercase would not run there.
const RFC_9562_TEXT_FORM =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;

/**
 * The same accept set as `brandedUuidIdSchema`, without a brand. For a wire member that is an id
 * by nature but whose brand is declared elsewhere, so the brand can be added later with no wire
 * change. Not for a client-minted opaque key that merely looks like a UUID; use `z.uuid()` there.
 */
export const uuidTextFormSchema: z.ZodType<string, string> = z
  .string()
  .regex(RFC_9562_TEXT_FORM, "Invalid UUID: expected an RFC 9562 text form");

/**
 * Builds a branded UUID id schema over the shared accept set, typed `ZodType<T, T>` so tRPC v11
 * infers its input; the `as unknown as` cast is needed for that, and `.brand()` still runs. The
 * message keeps the word "UUID" so a caller can tell which shape was owed.
 */
export function brandedUuidIdSchema<T extends string>(brandName: string): z.ZodType<T, T> {
  return z
    .string()
    .regex(RFC_9562_TEXT_FORM, "Invalid UUID: expected an RFC 9562 text form")
    .brand(brandName) as unknown as z.ZodType<T, T>;
}
