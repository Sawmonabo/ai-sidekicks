// What a COMPUTED reply does: read the request it was handed, and refuse.
//
// A `resultFor` computation receives `unknown` — deliberately, because the seam that
// hands it over reports settlements and throws none, so an exception raised inside one
// leaves past every refusal arm as itself. Both halves of that seam live here, and both
// for the same reason: every scenario that answers per entity needs the same two-step
// read, and every scenario that refuses needs the same one-line throw. Two copies of
// either drift into two different answers for one wire fact.
//
// ONE OF EACH RATHER THAN SIX. `refuseAs` was written privately in three scenario modules
// before this one needed a fourth, and the request read had three implementations of its
// own under two names — byte-identical bodies, so nothing reported them and each was one
// edit away from disagreeing with the others about a malformed call. This package's
// shared-code rule names a refusal constructor and a parser among the things to grep for
// before writing one, which is what found them.
//
// THE REFUSAL SHAPE IS THE WIRE ENVELOPE'S AND NOT THE CONSOLE'S. `core/refusal.ts` owns
// `ConsoleRefusal`, which is what a SURFACE renders after a settlement; a scenario that
// threw one of those would be answering with the reading rather than with what the daemon
// said, and every layer between would have nothing left to do.
//
// Hoisted here on the second use, per this package's shared-code rule.

import type { WireErrorEnvelope } from "../../core/index.js";

/**
 * One identifier off a request a scenario was asked with, or `undefined`.
 *
 * `undefined` covers all three ways the answer is not available: the request is not an
 * object, the member is absent, and the member is present but is not a string. A
 * scenario that treated those differently would be inventing a taxonomy for malformed
 * calls that no transport produces.
 */
export function requestedIdentifier(request: unknown, member: string): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const value = (request as Readonly<Record<string, unknown>>)[member];
  return typeof value === "string" ? value : undefined;
}

/**
 * The answer a table holds for the entity one request names, or `undefined`.
 *
 * A request naming an entity this scenario does not hold answers `undefined` and the
 * fixture refuses, which is the honest answer for a scenario that scripts two mounts
 * and is asked about a third.
 */
export function answerFor(
  answersByEntityId: Readonly<Record<string, unknown>>,
  entityIdMember: string,
  request: unknown,
): unknown {
  const requestedEntityId = requestedIdentifier(request, entityIdMember);
  return requestedEntityId === undefined ? undefined : answersByEntityId[requestedEntityId];
}

/**
 * Refuse this call as the daemon would, under one of the codes the corpus registers.
 *
 * `never`, so a caller reads as a guard rather than as a branch whose other arm has to
 * answer something. The envelope is thrown rather than returned because a computed reply
 * has no refusal channel — returning `undefined` is how it says it scripts no answer,
 * which is a different fact and one a surface renders differently.
 */
export function refuseAs(code: string, message: string): never {
  const envelope: WireErrorEnvelope = { code, message };
  throw envelope;
}
