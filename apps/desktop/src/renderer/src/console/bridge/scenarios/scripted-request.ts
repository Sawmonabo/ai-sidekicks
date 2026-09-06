// How a computed reply READS the request it was handed.
//
// A `resultFor` computation receives `unknown` — deliberately, because the seam that
// hands it over reports settlements and throws none, so an exception raised inside one
// leaves past every refusal arm as itself. Every scenario that answers per entity
// therefore needs the same two-step read: prove the request is an object, then take
// one member off it as a string. Two copies of that read drift into two different
// answers for a malformed call, and the honest one is `undefined` — which the fixture
// turns into its own "scripts no reply" refusal, the one answer a surface can act on.
//
// Hoisted here on the second use, per this package's shared-code rule.

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
