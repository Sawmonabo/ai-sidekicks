// The small scalar rules several contract modules share. Internal: not re-exported from
// `src/index.ts`.
import { z } from "zod";

/**
 * A daemon-composed string: a path, a provider's words, a name. The reply
 * schemas guard the daemon's own composition, so non-empty is the rule they
 * enforce.
 */
export const composedTextSchema: z.ZodString = z.string().min(1);

/** A count of things, or a number of seconds or bytes: a whole number, zero or more. */
export const countSchema: z.ZodNumber = z.number().int().nonnegative();

/** A share in percent, from 0 to 100; a fraction is allowed. */
export const percentSchema: z.ZodNumber = z.number().min(0).max(100);

/** An RFC 3339 instant carrying its offset, as every timestamp on the wire does. */
export const isoDateTimeSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });

/** A TCP port number: a whole number from 1 to 65535. */
export const portSchema: z.ZodNumber = z.number().int().min(1).max(65_535);
