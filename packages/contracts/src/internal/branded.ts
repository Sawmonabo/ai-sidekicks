// Internal helpers for the contracts package; the package's exports map closes `internal/*`.
import { z } from "zod";

// The RFC 9562 UUID text form shared by every branded UUID id, in any case, plus the Nil and Max
// UUIDs. Not `z.uuid()`, which refuses an upper-case Nil or Max. It normalizes nothing: ids are
// branded by casts at database reads, where a schema could not lowercase them, so canonical casing
// is applied at each map-key or hash-input boundary (`uuid-canonical.ts`).
const RFC_9562_TEXT_FORM = new RegExp(
  "^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" +
    "|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
  "iu",
);

/**
 * The same accept set as `brandedUuidIdSchema`, without a brand: for a wire member that is an id
 * whose brand is declared elsewhere. A client-minted key that merely looks like a UUID uses
 * `z.uuid()` instead.
 */
export const uuidTextFormSchema: z.ZodType<string, string> = z
  .string()
  .regex(RFC_9562_TEXT_FORM, "Invalid UUID: expected an RFC 9562 text form");

/**
 * Builds a branded UUID id schema over the shared accept set, cast to `ZodType<T, T>` so a
 * composing schema infers its input as `T`.
 */
export function brandedUuidIdSchema<T extends string>(brandName: string): z.ZodType<T, T> {
  return z
    .string()
    .regex(RFC_9562_TEXT_FORM, "Invalid UUID: expected an RFC 9562 text form")
    .brand(brandName) as unknown as z.ZodType<T, T>;
}
