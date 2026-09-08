// Reading one member off a value the type system was never given.
//
// The fixture holds two kinds of value it cannot type: a scenario's `result`, which is
// deliberately `unknown` so a scenario can carry any registered reply, and the REQUEST
// a computed reply is handed, which is `unknown` for the same reason at the other end
// of the seam. Both are read the same way — narrow the container, then narrow the
// member — and both were being read by a private copy of that narrowing, one in each
// reader that derived from a scenario's `result`, differing only in whether the string
// check was fused into the member read.
//
// A CAST WOULD BE THE ALTERNATIVE AND IS NOT ONE. Asserting the shape of a scenario's
// reply or of an incoming request states a fact nothing established: a scenario is
// authored by hand and a request arrives from a caller, so both are exactly the
// positions where a wrong shape is possible. The narrowing answers `undefined` for
// every value that is not what was asked for, which is what every reader here already
// has an arm for.
//
// It lives beside the scripted-reply seam rather than inside any one reader because its
// two importers straddle that seam. `fixture/workflows/workflow-scope.ts` derives what a
// scenario DECLARES; `scenarios/workflow-fixture-replies.ts` reads the REQUEST a computed
// reply is handed. A helper owned by either side would be reached from the other across a
// boundary that is not there. The seam is this directory's, so the string read leaves
// through its door and the container read it is built on does not.
//
// THE CONTAINER CHECK IS `core`'s, AND IT NARROWS. `isWireRecord` is the console's one
// reading of "this untyped value is a record" and it answers `false` for an array,
// which the private `typeof value === "object" && value !== null` copies it replaced
// did not — so an array now answers `undefined` for EVERY member, where before it
// answered through the index for the names an array does carry (`length`, `"0"`). No
// caller asks for one of those, so nothing moves on screen. The narrowing is what a
// shared predicate is for, and the suite beside this module pins the array arm so it
// stays a decision rather than a side effect of the hoist.

import { isWireRecord } from "../../core/index.js";

/** One member of a value that may not be an object at all. */
export function readUnknownMember(value: unknown, member: string): unknown {
  return isWireRecord(value) ? value[member] : undefined;
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

/**
 * One NUMBER member of such a value.
 *
 * The string reader's rule applied to the other primitive a request key is written
 * in: `undefined` covers "not an object", "that member is absent", and "that member
 * is not a number", because a caller that asked for a version ordinal and did not get
 * one does the same thing in all three cases.
 *
 * `Number.isFinite` and not `typeof === "number"`, which is the whole of the
 * difference: `NaN` and both infinities are numbers, and each would pass a bare
 * `typeof` check straight into a lookup keyed on an ordinal. A version this fixture
 * holds no body for is refused by name; a `NaN` compared against every stored number
 * is false everywhere and refuses for a reason nobody can read.
 */
export function readUnknownNumberMember(value: unknown, member: string): number | undefined {
  const read = readUnknownMember(value, member);
  return typeof read === "number" && Number.isFinite(read) ? read : undefined;
}
