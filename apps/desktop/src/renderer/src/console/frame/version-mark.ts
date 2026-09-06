// What this console and the local runtime agreed to speak, and what to do when they
// did not agree at all.
//
// WHY A WINDOW READS THIS AT ALL. The handshake is performed by the shell, once per
// connection, and everything it establishes has until now stayed there: which protocol
// was negotiated, which set the runtime supports, and — when the two builds do not meet
// — which of the three reasons refused them. The supervision lifecycle requires an
// incompatible handshake be surfaced to the renderer with mutating operations blocked
// and reads still permitted, and no bridge or preload namespace carries any of it, so
// the console asks for the whole reading on the growth slate's
// `daemon-version-negotiation` row and builds against the fixture until it lands.
//
// THE VERDICT IS THE DAEMON'S AND THE CONSOLE NEVER RE-DERIVES IT. `compatible` arrives
// on the reply and is the only thing that raises the banner. The membership below —
// whether this console's own version appears in the set the runtime published — is a
// DISPLAY of two published lists and never a second gate: where the two disagree the
// verdict wins, because the gate that refuses a mutating dispatch is registry-side and
// a renderer that recomputed it would be asserting a rule it does not own.
//
// AND THE REMEDY IS OURS TO WRITE, WHICH IS WHY IT IS A TOTAL SWITCH. The corpus
// registers the three reasons and writes no copy for any of them. Two of them name a
// side that is out of range — below the runtime's floor is the console's to move, above
// its ceiling is the runtime's — and the third names no version at all, so it gets its
// own arm rather than being folded into whichever of the two reads closer. A fourth
// reason registered on the wire fails at this switch rather than rendering as a guess.
//
// NO POLLING AND NO SECOND CADENCE. The read is put once through the console's single
// growth-read chokepoint, keyed on the port — which is minted once per bridge, so a
// re-render never re-reads and a bridge swapped underneath (the fixture's scenario
// switch, a reconnect that rebuilds one) does. There are no session-event kinds that
// owe this reading a fresh read either, and that is a fact about the QUESTION rather
// than an omission: the ack is a negotiation reply on a connection, not an event in any
// session's log, so no beat of any timeline can change what it said.

import type { NegotiationIncompatibleReason } from "@ai-sidekicks/contracts";

import { useSettledGrowthRead, type GrowthPort, type SettledReadRefusal } from "../bridge/index.js";

/** The two versions the mark puts side by side, and the set the runtime published. */
export interface ConsoleVersionMark {
  /** The protocol version this console proposed, from the hello it sent. */
  readonly consoleProtocolVersion: string;
  /** The protocol version the runtime answered with — the negotiated one where the two met. */
  readonly daemonProtocolVersion: string;
  /** Every version the runtime says it can speak, in the order it listed them. */
  readonly daemonSupportedProtocols: readonly string[];
  /**
   * Whether this console's own version is in that set — or `undefined` where the
   * runtime published no set at all, which is a different fact from publishing one
   * this console is missing from and is not collapsed into it.
   */
  readonly consoleProtocolIsSupported: boolean | undefined;
}

/** Which side of an incompatible handshake is the one that moves. */
export type VersionRemedySide = "console" | "runtime" | "neither";

/** The refused handshake, with the console's own reading of what to do about it. */
export interface ConsoleVersionMismatch {
  /** The runtime's own reason, verbatim. Rendered in mono as the refusal's code. */
  readonly reason: NegotiationIncompatibleReason;
  readonly movingSide: VersionRemedySide;
  /** One sentence: which side moves, and that reads carry on meanwhile. */
  readonly remedy: string;
}

/**
 * What the frame knows about the handshake at one moment.
 *
 * A discriminated union rather than one shape with optional members, because the
 * suppression rule is structural: the mark exists on the settled arm and on no other,
 * so a window that has not heard back, or that heard a refusal, has no version pair to
 * render stale. `unreachable` carries the refusal rather than dropping it — the console
 * says nothing about versions in that state, and the reason is still the diagnostic
 * band's.
 */
export type ConsoleVersionReading =
  | { readonly phase: "reading" }
  | { readonly phase: "unreachable"; readonly refusal: SettledReadRefusal }
  | {
      readonly phase: "read";
      readonly mark: ConsoleVersionMark;
      /** Present exactly when the runtime refused the handshake. */
      readonly mismatch: ConsoleVersionMismatch | undefined;
    };

/** What the read settles to, either kind. */
type SettledHandshake = Awaited<ReturnType<GrowthPort["daemonHello"]>> | SettledReadRefusal;

/**
 * The remedy for one refused handshake, as one table over the closed reason set.
 *
 * One switch and not two: the side that moves and the sentence a person reads are the
 * same decision made once, and deriving the copy from the side in a second switch would
 * be one mapping with two homes.
 */
function remedyFor(reason: NegotiationIncompatibleReason): {
  readonly movingSide: VersionRemedySide;
  readonly remedy: string;
} {
  switch (reason) {
    case "version.floor_exceeded":
      return {
        movingSide: "console",
        remedy:
          "This console speaks a protocol below the local runtime's minimum. Update the console. Reads carry on meanwhile; anything that would change the session is refused.",
      };
    case "version.ceiling_exceeded":
      return {
        movingSide: "runtime",
        remedy:
          "This console speaks a protocol above the local runtime's maximum. Update the local runtime. Reads carry on meanwhile; anything that would change the session is refused.",
      };
    case "protocol.handshake_already_completed":
      return {
        // Neither build is out of range, so neither version is the thing to move.
        // Folding this into one of the two above would name a side and send a person
        // to an installer for a connection fault.
        movingSide: "neither",
        remedy:
          "This connection had already completed a handshake, so the second one was refused. Neither version is out of range. Reads carry on meanwhile; anything that would change the session is refused.",
      };
  }
}

/** The reading, given the one read's settlement. */
function settledVersionReading(settlement: SettledHandshake): ConsoleVersionReading {
  if (settlement.status !== "served") {
    return { phase: "unreachable", refusal: settlement };
  }
  const answer = settlement.value;
  const supported = answer.daemonSupportedProtocols;
  return {
    phase: "read",
    mark: {
      consoleProtocolVersion: answer.consoleProtocolVersion,
      daemonProtocolVersion: answer.daemonProtocolVersion,
      daemonSupportedProtocols: supported,
      consoleProtocolIsSupported:
        supported.length === 0 ? undefined : supported.includes(answer.consoleProtocolVersion),
    },
    // Narrowed on the wire's own discriminant and on nothing this module worked out.
    mismatch: answer.compatible
      ? undefined
      : { reason: answer.reason, ...remedyFor(answer.reason) },
  };
}

/**
 * Read the handshake once, for as long as the window is mounted.
 *
 * The key is `undefined` because the port is the whole subject: a handshake belongs to
 * a connection and to no session, so keying it on whichever session happened to be open
 * would re-read a connection-wide fact on every navigation and hold one connection's
 * answer against another's.
 */
export function useConsoleVersionReading(growth: GrowthPort): ConsoleVersionReading {
  const { value } = useSettledGrowthRead<SettledHandshake, ConsoleVersionReading>(
    growth,
    undefined,
    () => growth.daemonHello({}),
    { unsettled: () => ({ phase: "reading" }), settled: settledVersionReading },
  );
  return value;
}
