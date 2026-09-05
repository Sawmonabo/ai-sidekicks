// The reach census the daemon-reply chokepoint next door runs: how a module shows it
// reached the bridge's call door, and how it shows it consumes it.
//
// A MODEL BESIDE ITS GATE, on the `barrel-census.ts` pattern. The gate reads the real
// console while its controls drive needles with sources written by hand to fail, and the
// two jobs had grown into one 433-line file. The needles take source text as a
// parameter; the walk that produces the real modules stays in the gate, where
// `source-walk-chokepoint.test.ts` can see it.
//
// THE INSTRUMENT IS SOURCE TEXT, and it has to be: the bridge's `call` answers `unknown`,
// so a surface that reaches it directly type-checks perfectly and reports success on a
// value nobody read. Every needle is anchored on SYNTAX rather than on the bare name,
// because the console's prose names `daemon.call` and `callDaemon` constantly and a
// needle that fired on a comment would be turned off within a week.

/**
 * How a module shows it reached the daemon call door, in the five shapes that reach.
 *
 * All five are deliberately anchored on syntax rather than on the bare name, because
 * `daemon.call` is a thing the console's own prose says constantly — the bridge
 * shape test names it as a member, the registry header names it as the generic
 * door — and a needle that flagged a comment would be turned off within a week.
 *
 *   • CALLED OR ALIASED matches `…daemon.call` only where a call, a type argument,
 *     or an `as` cast follows. That is the reach: invoking it, or widening its
 *     branded signature so it can be invoked.
 *   • NAMESPACE TAKEN matches the daemon namespace bound or spread rather than
 *     stepped through, which is how a determined evasion would be spelled. The
 *     negative lookahead is what keeps `…sidekicks.daemon.subscribe` out of it, and
 *     the bracket beside it hands a computed key to the form that names it.
 *   • The two COMPUTED KEY forms close the hole a dotted needle cannot see:
 *     `bridge.sidekicks["daemon"].call(…)` and `daemon["call"](…)` reach the same
 *     door, and neither is exotic — a member read through a variable key is how a
 *     helper written over "whichever namespace this is" spells itself. They are the
 *     smallest violations that passed the two dotted needles, measured.
 *   • TAKEN AS A VALUE catches the door handed on rather than invoked —
 *     `daemon.call.bind(bridge)` — which the first form's lookahead misses because
 *     what follows `call` is a dot rather than a parenthesis.
 *
 * The computed forms admit no whitespace before the bracket, and that is exact
 * rather than lax: every source file in this package is Prettier-formatted on the
 * way in, and Prettier writes no space there — while prose in a comment ("the daemon
 * [the local runtime] answers") writes one, so the spacing is what separates the two.
 *
 * Depth is honestly non-exhaustive: a value passed through two helpers defeats any
 * text scan, and so does a namespace reached through a variable that never names
 * `sidekicks`. The lint ban beside it is a second, different claim — a module that
 * cannot hold a validator cannot PARSE an unparsed reply it smuggled out — and it is
 * deliberately not offered as closing this one, since casting an `unknown` to the
 * response type needs no validator at all and is the first of the three mistakes the
 * registry header enumerates.
 */
const DAEMON_CALL_REACH_FORMS: readonly (readonly [string, RegExp])[] = [
  ["called or aliased", /\bdaemon\s*\.\s*call\b(?=\s*[(<]|\s+as\b)/],
  ["namespace taken", /\.\s*sidekicks\s*\.\s*daemon\b(?!\s*[.[])/],
  ["namespace taken by computed key", /\.\s*sidekicks\[/],
  ["called by computed key", /\bdaemon\[/],
  ["taken as a value", /\bdaemon\s*\.\s*call\s*\.\s*(?:bind|apply|call)\b/],
];

/** Which reach forms `source` contains, by name, or `[]`. */
export function daemonCallReaches(source: string): readonly string[] {
  return DAEMON_CALL_REACH_FORMS.filter(([, pattern]) => pattern.test(source)).map(
    ([name]) => name,
  );
}

/**
 * How a module shows it CONSUMES the call door: it imports the door's own name.
 *
 * Anchored on the SPECIFIER LIST rather than on two words in proximity. The needle this
 * replaces was `\bimport\b[^;]*\bcallDaemon\b`, and `[^;]*` spans newlines: a comment
 * anywhere in a module reading "a surface would import `callDaemon` from the bridge door
 * rather than reach the wire itself" matched it, because there is no `;` between the two
 * words. The consequence was not a miss but a red gate on prose, which is how a pinned
 * count gets raised to fix the test.
 *
 * The brace is what a comment cannot supply on the way to the name. `[^;{]*` before it
 * stops the scan at the first statement end or the first brace, so the two words have to
 * meet inside one import clause; `[^}]*` after it still spans newlines, so a multi-line
 * specifier list is one import.
 */
export const CALL_DOOR_IMPORT: RegExp = /\bimport\b[^;{]*\{[^}]*\bcallDaemon\b/u;
