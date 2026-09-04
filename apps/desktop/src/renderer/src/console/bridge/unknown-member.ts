// Reading one member off a value the type system was never given.
//
// The fixture holds two kinds of value it cannot type: a scenario's `result`, which is
// deliberately `unknown` so a scenario can carry any registered reply, and the REQUEST
// a computed reply is handed, which is `unknown` for the same reason at the other end
// of the seam. Both are read the same way — narrow the container, then narrow the
// member — and both were being read by a private copy of that narrowing: one in
// `fixture-workflow-scope.ts` and one in `fixture-session-directory.ts`, differing only
// in whether the string check was fused into the member read.
//
// A CAST WOULD BE THE ALTERNATIVE AND IS NOT ONE. Asserting the shape of a scenario's
// reply or of an incoming request states a fact nothing established: a scenario is
// authored by hand and a request arrives from a caller, so both are exactly the
// positions where a wrong shape is possible. The narrowing answers `undefined` for
// every value that is not what was asked for, which is what every reader here already
// has an arm for.
//
// It lives at the bridge's own level rather than inside either reader because its two
// callers sit on opposite sides of the scripted-reply seam — one derives what a
// scenario declares, the other answers a request — and a helper owned by one of them
// would be reached by the other across a boundary that is not there.

/** One member of a value that may not be an object at all. */
export function readUnknownMember(value: unknown, member: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)[member]
    : undefined;
}

/**
 * One STRING member of such a value.
 *
 * `undefined` covers both "not an object" and "that member is not a string", because
 * every caller does the same thing with the two: it asked for an identifier and did
 * not get one, and a second discriminator would be the same question asked twice.
 */
export function readUnknownStringMember(value: unknown, member: string): string | undefined {
  const read = readUnknownMember(value, member);
  return typeof read === "string" ? read : undefined;
}
