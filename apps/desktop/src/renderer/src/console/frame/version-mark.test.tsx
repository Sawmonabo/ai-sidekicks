// The handshake read has three phases, and the mark must be absent in two of them.
//
// Every case drives the REAL hook over a REAL port — the fixture's for the scripted
// answer, the refusing one for a window that has no seam to ask through, and a real
// port with exactly one method replaced where the case needs an answer no shipped
// scenario states. A hand-written promise shaped like a port would agree with whatever
// the hook did with it, which is the one thing these cases are for.
//
// AND THE SUPPRESSION CLAIM IS STRUCTURAL. `ConsoleVersionReading` carries the mark on
// the settled arm and on no other, so "shows nothing stale" is asserted by narrowing
// rather than by reading a field back — a window that has not heard from the runtime
// has no version pair to have kept.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import {
  createRefusingGrowthPort,
  type GrowthServedValue,
} from "../bridge/growth-port/growth-port.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { settleReactWork } from "../core/act-settlement.test-support.js";
import { useConsoleVersionReading, type ConsoleVersionReading } from "./version-mark.js";

/** The version this console proposes in every case below. */
const CONSOLE_VERSION = "2026-05-01";

/** A version the runtime speaks and this console does not. */
const RUNTIME_ONLY_VERSION = "2026-09-01";

/** A real port with exactly one method answering a stated handshake. */
function handshakePort(value: GrowthServedValue<"daemonHello">): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    daemonHello: async () => ({ status: "served", value }),
  };
}

function ReadingProbe(props: {
  readonly growth: GrowthPort;
  readonly onObserve: (reading: ConsoleVersionReading) => void;
}): React.JSX.Element {
  props.onObserve(useConsoleVersionReading(props.growth));
  return <></>;
}

function observeReading(growth: GrowthPort): ConsoleVersionReading[] {
  const observed: ConsoleVersionReading[] = [];
  render(
    <ReadingProbe
      growth={growth}
      onObserve={(reading) => {
        observed.push(reading);
      }}
    />,
  );
  return observed;
}

function lastReading(observed: readonly ConsoleVersionReading[]): ConsoleVersionReading {
  const reading = observed.at(-1);
  if (reading === undefined) {
    throw new Error("the probe never rendered, so there is no reading to read");
  }
  return reading;
}

afterEach(() => {
  cleanup();
});

describe("useConsoleVersionReading — one read, three phases", () => {
  it("shows nothing at all while the read is in flight", () => {
    const observed = observeReading(
      handshakePort({
        compatible: true,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: CONSOLE_VERSION,
        daemonSupportedProtocols: [CONSOLE_VERSION],
      }),
    );

    // The first phase is load-bearing: a reading that started settled would put a
    // version pair on screen for a handshake nobody had read back yet.
    expect(observed[0]).toStrictEqual({ phase: "reading" });
  });

  it("is unreachable — and carries no mark — when the seam does not serve the read", async () => {
    const observed = observeReading(createRefusingGrowthPort());

    await settleReactWork();
    const settled = lastReading(observed);
    expect(settled.phase).toBe("unreachable");
    // "Suppressed while unreachable, never stale": the arm has no mark to hold, so
    // there is no last-known pair for a later render to keep showing.
    expect(settled).not.toHaveProperty("mark");
    if (settled.phase === "unreachable") {
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.operationId).toBe("daemonHello");
      expect(settled.refusal.slateRow).toBe("daemon-version-negotiation");
    }
  });

  it("reads the version pair and raises nothing when the two builds met", async () => {
    const observed = observeReading(
      handshakePort({
        compatible: true,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: CONSOLE_VERSION,
        daemonSupportedProtocols: [CONSOLE_VERSION, RUNTIME_ONLY_VERSION],
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    expect(settled.phase).toBe("read");
    if (settled.phase === "read") {
      expect(settled.mismatch).toBeUndefined();
      expect(settled.mark.consoleProtocolVersion).toBe(CONSOLE_VERSION);
      expect(settled.mark.daemonProtocolVersion).toBe(CONSOLE_VERSION);
      expect(settled.mark.consoleProtocolIsSupported).toBe(true);
    }
  });

  it("reads the pair AND the refusal when the runtime turned the handshake down", async () => {
    const observed = observeReading(
      handshakePort({
        compatible: false,
        reason: "version.floor_exceeded",
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: RUNTIME_ONLY_VERSION,
        daemonSupportedProtocols: [RUNTIME_ONLY_VERSION],
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    expect(settled.phase).toBe("read");
    if (settled.phase === "read") {
      // The pair survives the refusal rather than being replaced by it: a person told
      // the two sides disagree and not which two versions disagreed has been told
      // nothing they can act on.
      expect(settled.mark.daemonProtocolVersion).toBe(RUNTIME_ONLY_VERSION);
      expect(settled.mark.consoleProtocolIsSupported).toBe(false);
      expect(settled.mismatch?.reason).toBe("version.floor_exceeded");
      expect(settled.mismatch?.movingSide).toBe("console");
    }
  });

  it("says the runtime published no set rather than calling this console unsupported", async () => {
    const observed = observeReading(
      handshakePort({
        compatible: true,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: CONSOLE_VERSION,
        daemonSupportedProtocols: [],
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    if (settled.phase === "read") {
      // Not `false`. A runtime that listed nothing has said nothing about this
      // console's version, and reading that as "unsupported" is a verdict nobody
      // reached — the fact the two are kept apart for.
      expect(settled.mark.consoleProtocolIsSupported).toBeUndefined();
    }
  });
});

describe("the remedy — chosen by which side is out of range", () => {
  it.each([
    ["version.floor_exceeded", "console"],
    ["version.ceiling_exceeded", "runtime"],
    ["protocol.handshake_already_completed", "neither"],
  ] as const)("sends %s to the %s", async (reason, movingSide) => {
    const observed = observeReading(
      handshakePort({
        compatible: false,
        reason,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: RUNTIME_ONLY_VERSION,
        daemonSupportedProtocols: [RUNTIME_ONLY_VERSION],
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    if (settled.phase === "read") {
      expect(settled.mismatch?.movingSide).toBe(movingSide);
      // Every arm says reads carry on, because that is the half of the state a person
      // most needs and the half a refusal banner is least likely to carry.
      expect(settled.mismatch?.remedy).toContain("Reads carry on");
    }
  });

  it("negative control: deriving the verdict from the published set disagrees with the wire", async () => {
    // The rule this pins is "never computes compatibility". Here the runtime says the
    // handshake is FINE and its published set does not name this console's version —
    // which happens whenever the set is stale, partial, or simply not sent. A hook that
    // read membership as the verdict would raise a persistent refusal across a window
    // that is working, so this plants exactly that derivation and shows it disagrees
    // with the one the shipped hook takes.
    const answer: GrowthServedValue<"daemonHello"> = {
      compatible: true,
      consoleProtocolVersion: CONSOLE_VERSION,
      daemonProtocolVersion: RUNTIME_ONLY_VERSION,
      daemonSupportedProtocols: [RUNTIME_ONLY_VERSION],
    };
    const observed = observeReading(handshakePort(answer));

    await settleReactWork();
    const settled = lastReading(observed);
    const derivedFromMembership = !answer.daemonSupportedProtocols.includes(
      answer.consoleProtocolVersion,
    );

    expect(derivedFromMembership).toBe(true);
    if (settled.phase === "read") {
      expect(settled.mismatch).toBeUndefined();
      // And the membership is still SHOWN, because it is a fact about two published
      // lists. What it is not is the gate.
      expect(settled.mark.consoleProtocolIsSupported).toBe(false);
    }
  });
});

describe("the fixture's own handshake", () => {
  it("serves the scripted agreement, so a fixture window renders a pair", async () => {
    const outcome = await createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth.daemonHello(
      {},
    );

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.compatible).toBe(true);
      expect(outcome.value.daemonSupportedProtocols).toContain(
        outcome.value.consoleProtocolVersion,
      );
    }
  });

  it("keeps that answer out of the live bridge, which still has no wire for it", async () => {
    const outcome = await createRefusingGrowthPort().daemonHello({});

    expect(outcome.status).toBe("unavailable");
    expect(outcome).not.toHaveProperty("value");
  });
});
