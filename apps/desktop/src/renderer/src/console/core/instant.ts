// One reading of a wire instant, for the whole console.
//
// Before this module the console read an RFC 3339 stamp four different ways, and
// three of them were wrong in a way nothing caught:
//
//   • COMPARED AS TEXT. An RFC 3339 instant may carry a numeric offset as readily
//     as `Z`, so one instant has many spellings and two spellings sort by neither:
//     `2026-01-01T10:00:00+02:00` is an hour EARLIER than `2026-01-01T09:00:00Z`
//     and sorts AFTER it in every lexical comparison — `localeCompare`, `<`, `>`.
//     A list ordered that way showed the wrong row as newest.
//   • PARSED WITH `Date.parse` AND NOTHING ELSE. That function is not a validator.
//     It reads a timezone-less `2026-01-01T10:00:00` in the HOST's zone, a
//     date-only `2026-01-01` in UTC, and it NORMALIZES a date that does not exist:
//     `2026-02-30T10:00:00Z` becomes March 2 and `2026-01-01T24:00:00Z` becomes the
//     next day. Each answers a number, so the `Number.isNaN` guard every call site
//     wrote passes and a surface renders an instant the wire never sent.
//   • VALIDATED FIELD BY FIELD AT ONE CALL SITE. Correct where it was written, and
//     invisible to the three sites that were not.
//
// So there is one parse, one comparison, and one place the rule is stated.
//
// THE LIBRARY QUESTION, ANSWERED BY MEASUREMENT.
//
//   • `Temporal` — absent. `typeof globalThis.Temporal` is `"undefined"` on Node
//     22.14 (this repo's floor), and still `"undefined"` on Node 24.18 (measured
//     2026-09-04). The `console-unit` tier runs under Node, not under Electron's
//     V8, so a `Temporal`-based parser would fail the tier that gates every console
//     PR even where Electron's Chromium carried the API. That is the same
//     runtime-range finding `primitives/wire-figures.ts` records for
//     `Intl.DurationFormat`, and it has the same consequence: a guarded two-path
//     implementation would read one way in CI and another in production, which is
//     the single outcome a chokepoint exists to prevent.
//   • `@js-temporal/polyfill` — declined. It ships the whole Temporal object model
//     to buy one predicate, and the console's bundle budget is a gate rather than a
//     preference (`Spec-023 §Console Design (Meridian)`).
//   • `date-fns` `parseISO` — declined, and on correctness rather than on size. It
//     is documented to accept what this console must refuse: a date-only value and
//     a timezone-less value both parse, and the second is read in the host's zone —
//     the exact leniency that made `Date.parse` unusable here.
//   • `zod` — ADOPTED, and it costs nothing: it is already a dependency of this
//     package, already imported by `bridge/run-stream-projection.ts` and
//     `bridge/scenarios/wire-truth/run-and-queue-semantics.ts`, so it is already in
//     the renderer bundle and this module adds no byte to it. `packages/contracts`
//     validates its own wire instants with this same `z.iso` family, so the console
//     reads the wire's encoding through the validator the wire's own schemas are
//     written in. Measured against zod 4.3.6 rather than assumed: `2026-02-30`,
//     `2027-02-29`, `2026-04-31`, `2026-13-01`, hour `24`, and second `60` are each
//     refused, where `Date.parse` answers a number for four of the six. It
//     validates the CALENDAR and the CLOCK, not just the digit groups.
//
// TWO NARROWINGS THE ADOPTION COSTS, recorded rather than discovered later. zod's
// `z.iso.datetime` refuses a leap second (`23:59:60Z`), which RFC 3339 §5.6 permits,
// and refuses the lowercase `t` / `z` separators that same section permits. Both
// read as malformed here. Neither is emitted by anything this console talks to, and
// both fail CLOSED — an em dash and a row sorted last, never a wrong instant.

import { z } from "zod";

/**
 * The wire's encoding: RFC 3339, with `Z` or a numeric offset.
 *
 * `offset: true` is what admits `+02:00` beside `Z`. It is deliberately wider than
 * the Z-only default, because this is the CONSOLE's parser and the console reads
 * every plane: `packages/contracts` opts into offsets on its own instants, and a
 * reader that refused them would report a daemon's valid stamp as malformed.
 *
 * `local` stays at its default of `false`, which is the load-bearing half: a
 * timezone-less `2026-01-01T10:00:00` names no instant at all, and `Date.parse`
 * resolves it in whatever zone the operator's machine happens to be in.
 */
const RFC_3339_INSTANT = z.iso.datetime({ offset: true });

/** A stamp this console could read. */
export interface Instant {
  readonly kind: "instant";
  /** Epoch milliseconds. The only number any caller may do arithmetic on. */
  readonly epochMilliseconds: number;
  /** The wire's own spelling, kept so a refusal can quote what it was given. */
  readonly text: string;
}

/**
 * A stamp this console could not read.
 *
 * `epochMilliseconds` is declared here as `undefined` rather than omitted, and that
 * is the whole ergonomic design: TypeScript lets a property be read off a union only
 * when every member declares it, so `parseInstant(iso).epochMilliseconds` types as
 * `number | undefined` with no narrowing ceremony at the call sites that only want
 * the number, while a caller that must tell the two apart still narrows on `kind`.
 * One export serves both, so no second accessor exists to drift from this one.
 */
export interface MalformedInstant {
  readonly kind: "malformed";
  readonly epochMilliseconds?: undefined;
  /** What was given. Never widened into prose here — the caller writes the sentence. */
  readonly text: string;
}

/** What {@link parseInstant} answers. Closed at two arms. */
export type InstantReading = Instant | MalformedInstant;

/**
 * Read one wire instant.
 *
 * TWO CONJUNCTS, IN THIS ORDER, and neither alone is the reading. The validator
 * answers WHETHER the string names a real instant in the encoding the wire declares;
 * `Date.parse` then answers WHICH one. Running the parse second — over a value
 * already known to name a real calendar day and a real time of day — is what stops
 * the two disagreeing: a shape-only check leaves `Date.parse` free to answer a
 * number for a date that does not exist.
 *
 * Total. Every input answers a reading; nothing throws. A non-string reaching here
 * past the type (a wire value the console did not itself validate) is refused by the
 * validator like any other malformed value, so no runtime `typeof` guard is needed
 * to make that claim true.
 */
export function parseInstant(text: string): InstantReading {
  if (!RFC_3339_INSTANT.safeParse(text).success) {
    return { kind: "malformed", text };
  }
  const epochMilliseconds = Date.parse(text);
  // Unreachable at the validator's four-digit-year bound, and kept because the
  // alternative is a function whose totality depends on a range argument rather than
  // on a branch: an instant the platform cannot represent is malformed here, not a
  // `NaN` escaping into arithmetic three families away.
  if (Number.isNaN(epochMilliseconds)) {
    return { kind: "malformed", text };
  }
  return { kind: "instant", epochMilliseconds, text };
}

/** Which end of the order the newest instant belongs at. */
export type InstantOrder = "oldest-first" | "newest-first";

/**
 * Order two readings.
 *
 * MALFORMED SORTS LAST IN BOTH DIRECTIONS, and that is why this takes the direction
 * as an argument instead of leaving the caller to reverse it. A comparator that only
 * ascends is reversed by swapping its arguments — which reverses where the
 * unreadable values land too, so the same list puts them last when sorted one way
 * and FIRST when sorted the other. A numeric sentinel has the identical defect from
 * the other side: `-Infinity` is least, so it is last ascending and first
 * descending. Handling the arm before the numeric comparison is what makes "a row
 * whose stamp we could not read never displaces one we could" true in both
 * directions.
 *
 * Two unreadable readings TIE, deliberately: they carry no information to order by,
 * so the caller's next sort key decides, exactly as it does for two equal instants.
 *
 * Takes readings rather than strings so a sort parses once per row instead of twice
 * per comparison — the decorate-then-sort shape, and the reason this allocates
 * nothing on the comparison path.
 */
export function compareInstants(
  left: InstantReading,
  right: InstantReading,
  order: InstantOrder = "oldest-first",
): number {
  if (left.kind === "malformed") {
    return right.kind === "malformed" ? 0 : 1;
  }
  if (right.kind === "malformed") {
    return -1;
  }
  const ascending = left.epochMilliseconds - right.epochMilliseconds;
  // `Math.sign` rather than the difference itself: epoch milliseconds are far inside
  // the safe-integer range so the subtraction is exact, but a comparator that
  // returns a magnitude invites a caller to read one, and the only contract `sort`
  // has is the sign.
  return Math.sign(order === "newest-first" ? -ascending : ascending);
}
