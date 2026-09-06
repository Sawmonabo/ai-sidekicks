// The refusal an unopenable stream settles as, for every reading that opens one.
//
// A module here rather than a function beside each feed, on this directory's own
// rule: it is about the READING and not about any one wire. Two feeds had written it
// separately under one name — byte-identical bodies differing only in a constant
// declared in the same file, each carrying a doc block restating the other's, the
// second of them explicitly "on the queue family's rule next door" — which is a rule
// with two copies and no instrument holding them together, and precisely the
// hand-written refusal constructor `apps/desktop/AGENTS.md` names.
//
// THE ORIGIN IS THE PARAMETER, AND IT IS THE ONLY THING A CALLER SUPPLIES. That is
// what the two copies actually differed in, and it is the half a subsystem owns:
// `session-queue` and `provider-account-quota` are different subsystems and a refusal
// that named one of them for the other would send a reader to the wrong fold.

import { normalizeWireRejection, type ConsoleRefusal } from "../../core/index.js";

/**
 * A rejected stream open as the console's one refusal shape, in a caller's name.
 *
 * The console's ONE reading of a rejected promise, consumed rather than re-derived.
 * `normalizeWireRejection` already unwraps a `ConsoleRefusalError`'s carried refusal
 * structurally — which is what keeps the subscription wrapper's own unscoped-open code
 * intact instead of replacing it with the caller's origin and a stringified message —
 * and already takes a typed envelope's dotted code off `data.type`, where a
 * `{ code: string }` guard cannot see it. All a caller supplies is the origin.
 *
 * NO FALLBACK PAIR, deliberately. The fallback exists for a seam that knows its
 * failure better than the thrown value does, and a stream open does not: it failed for
 * a transport reason the transport already states — "the preload is a stub" is the
 * sentence someone acts on, and a house sentence about a live tail would displace it
 * with a paraphrase that names nothing to fix.
 */
export function streamRefusalFor(origin: string, rejection: unknown): ConsoleRefusal {
  return normalizeWireRejection(origin, rejection);
}
