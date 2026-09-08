// Whether a first send pins, and whether the port keeps its two promises about when.
//
// `auto-pin.test.ts` beside this file already drives the five conjuncts over
// literals, so nothing here re-asserts them. What these cases are about is the part
// the rule cannot know: which send is the FIRST one, whose markers are being read,
// and whether a durable write happened at all — the three facts that were missing
// while `autoPinDecision` had no consumer but a sentence on screen.
//
// The bridge is the real fixture bridge rather than a bare object, because it is the
// port's KEY: the record retires with the bridge it was stamped under, and a
// stand-in that was not a bridge would prove nothing about that lifetime.

import { describe, expect, it } from "vitest";

import { createFixture } from "../../bridge/fixture/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import type { SessionOriginEvidence } from "./auto-pin.js";
import {
  firstSendAutoPinSettlement,
  recordConsoleStartedSession,
  settleFirstSendAutoPin,
  type SessionAutoPinAuthority,
} from "./session-auto-pin.js";

/** A session this window started: every marker known, none of them an exclusion. */
const STARTED_HERE: SessionOriginEvidence = {
  isDraftPlaceholder: true,
  arrivedByImport: false,
  openedForChildWork: false,
  startedByWorkflow: false,
};

/** A distinct session per case, so no case inherits another's ledger entry. */
let nextSessionOrdinal = 0;
function freshSessionId(): string {
  nextSessionOrdinal += 1;
  return `session-auto-pin-${String(nextSessionOrdinal)}`;
}

interface RecordingAuthority extends SessionAutoPinAuthority {
  readonly pinned: string[];
  /** How many times the switch was read, so a case can prove it was read LATE. */
  readonly switchReads: () => number;
}

/**
 * The durable half, recorded rather than performed.
 *
 * The switch is a function the case can move between the stamp and the send, which
 * is the whole reason the authority reads rather than holds: a person who turns the
 * switch off after starting a session and before sending into it has changed their
 * mind, and the send must answer the switch as it stands.
 */
function recordingAuthority(isEnabled: () => boolean): RecordingAuthority {
  const pinned: string[] = [];
  let reads = 0;
  return {
    pinned,
    switchReads: () => reads,
    readAutoPinOnFirstSend: () => {
      reads += 1;
      return isEnabled();
    },
    pinToFront: (sessionId: string) => {
      pinned.push(sessionId);
    },
  };
}

function fixtureBridge(): ConsoleBridge {
  return createFixture().bridge;
}

describe("the auto-pin port — a first send, and the record it reads", () => {
  it("pins once on the first send into a session this console started", () => {
    const bridge = fixtureBridge();
    const sessionId = freshSessionId();
    const authority = recordingAuthority(() => true);
    recordConsoleStartedSession({ bridge, sessionId, origin: STARTED_HERE, authority });

    const settlement = settleFirstSendAutoPin(bridge, sessionId);

    expect(settlement).toStrictEqual({ pinned: true });
    expect(authority.pinned).toStrictEqual([sessionId]);
  });

  it("pins nothing on the second send, and says the first one already answered", () => {
    const bridge = fixtureBridge();
    const sessionId = freshSessionId();
    const authority = recordingAuthority(() => true);
    recordConsoleStartedSession({ bridge, sessionId, origin: STARTED_HERE, authority });

    settleFirstSendAutoPin(bridge, sessionId);
    const second = settleFirstSendAutoPin(bridge, sessionId);

    expect(second).toStrictEqual({ pinned: false, because: "not-the-first-send" });
    // The gate is the ledger and not the pin map: a person who moved the session back
    // to the rear tier themselves has made a decision, and a second send re-putting
    // the pin would overwrite it.
    expect(authority.pinned).toStrictEqual([sessionId]);
  });

  it("pins nothing while the switch is off, and names the switch as the reason", () => {
    const bridge = fixtureBridge();
    const sessionId = freshSessionId();
    const authority = recordingAuthority(() => false);
    recordConsoleStartedSession({ bridge, sessionId, origin: STARTED_HERE, authority });

    const settlement = settleFirstSendAutoPin(bridge, sessionId);

    expect(settlement).toStrictEqual({ pinned: false, because: "setting-off" });
    expect(authority.pinned).toStrictEqual([]);
  });

  it("reads the switch at the send rather than at the start", () => {
    // The reason the authority is two verbs rather than a boolean and a verb. A
    // session is stamped when it is created and consulted when a message is sent,
    // and a switch turned off in between is a decision a person made.
    const bridge = fixtureBridge();
    const sessionId = freshSessionId();
    let isEnabled = true;
    const authority = recordingAuthority(() => isEnabled);
    recordConsoleStartedSession({ bridge, sessionId, origin: STARTED_HERE, authority });
    expect(authority.switchReads()).toBe(0);

    isEnabled = false;
    const settlement = settleFirstSendAutoPin(bridge, sessionId);

    expect(settlement).toStrictEqual({ pinned: false, because: "setting-off" });
    expect(authority.pinned).toStrictEqual([]);
  });

  it("declines to guess for a session nobody stamped, and writes no ledger entry", () => {
    // Every session that reaches the composer from the node's directory: the wire
    // carries no origin marker at all, so the rule's fail-closed arm is the answer
    // and this port has nothing to add to it.
    const bridge = fixtureBridge();
    const sessionId = freshSessionId();

    const settlement = settleFirstSendAutoPin(bridge, sessionId);

    expect(settlement).toStrictEqual({ pinned: false, because: "origin-unreported" });
    // Nothing recorded, so the ledger stays proportional to the start presses a
    // person actually made rather than to every session they ever sent into.
    expect(firstSendAutoPinSettlement(bridge, sessionId)).toBeUndefined();
  });

  it("answers a different bridge as an unreported origin, record and all", () => {
    // The lifetime the WeakMap key buys. The durable store behind the switch and the
    // pin map is minted per bridge and replaced with it, so a record that survived a
    // bridge swap would answer a send by writing into a database nothing reads.
    const stampedBridge = fixtureBridge();
    const replacementBridge = fixtureBridge();
    const sessionId = freshSessionId();
    const authority = recordingAuthority(() => true);
    recordConsoleStartedSession({
      bridge: stampedBridge,
      sessionId,
      origin: STARTED_HERE,
      authority,
    });

    const settlement = settleFirstSendAutoPin(replacementBridge, sessionId);

    expect(settlement).toStrictEqual({ pinned: false, because: "origin-unreported" });
    expect(authority.pinned).toStrictEqual([]);
  });

  it("keeps two sessions' settlements apart under one bridge", () => {
    // The negative control for the ledger's key: a port that recorded the settlement
    // per BRIDGE rather than per session would answer the second session's first
    // send with the first session's verdict, and would pin nothing for it.
    const bridge = fixtureBridge();
    const firstSessionId = freshSessionId();
    const secondSessionId = freshSessionId();
    const authority = recordingAuthority(() => true);
    recordConsoleStartedSession({
      bridge,
      sessionId: firstSessionId,
      origin: STARTED_HERE,
      authority,
    });
    recordConsoleStartedSession({
      bridge,
      sessionId: secondSessionId,
      origin: STARTED_HERE,
      authority,
    });

    settleFirstSendAutoPin(bridge, firstSessionId);
    const second = settleFirstSendAutoPin(bridge, secondSessionId);

    expect(second).toStrictEqual({ pinned: true });
    expect(authority.pinned).toStrictEqual([firstSessionId, secondSessionId]);
  });

  it("carries the rule's own refusal through rather than re-deciding it", () => {
    // A session stamped with a marker the rule excludes on. The reason a person reads
    // has to be the rule's, so a conjunct that moves moves this too.
    const bridge = fixtureBridge();
    const sessionId = freshSessionId();
    const authority = recordingAuthority(() => true);
    recordConsoleStartedSession({
      bridge,
      sessionId,
      origin: { ...STARTED_HERE, startedByWorkflow: true },
      authority,
    });

    expect(settleFirstSendAutoPin(bridge, sessionId)).toStrictEqual({
      pinned: false,
      because: "started-by-workflow",
    });
    expect(authority.pinned).toStrictEqual([]);
  });
});
