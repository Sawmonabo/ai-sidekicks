// What the main process reported, and whether two reports say the same thing.

import { describe, expect, it } from "vitest";

import type { MainProcessNegotiation, MainProcessState } from "@shared/daemon-status-topic.js";
import { describeDaemonConnection, mainProcessReportsAreEqual } from "./main-process-state.js";
import { REPORTED_CONNECTIONS } from "@test/helpers/main-process-states.js";

describe("describeDaemonConnection", () => {
  it("answers a non-empty sentence for every supervisor state", () => {
    const described = new Set<string>();
    for (const connection of [{ kind: "unreported" } as const, ...REPORTED_CONNECTIONS]) {
      const sentence = describeDaemonConnection(connection);
      expect(sentence.length, connection.kind).toBeGreaterThan(0);
      described.add(sentence);
    }
    // Distinct per state: two states sharing a sentence would be indistinguishable to a person.
    expect(described.size).toBe(REPORTED_CONNECTIONS.length + 1);
  });
});

describe("mainProcessReportsAreEqual", () => {
  const base: MainProcessState = {
    connection: { kind: "reconnecting", attempt: 1, attemptLimit: 5 },
    negotiation: undefined,
    lastHeartbeatAt: "2026-01-01T10:00:00.000Z",
    transport: "loopback",
    keystore: "unavailable",
    startedByApp: true,
    whileSignedOut: undefined,
    cannotStart: undefined,
  };

  it("holds two identical reports equal across object identity", () => {
    expect(mainProcessReportsAreEqual(base, { ...base, connection: { ...base.connection } })).toBe(
      true,
    );
  });

  it("sees the attempt move", () => {
    // A ladder that advanced is a new report; missing it would freeze the count on screen.
    expect(
      mainProcessReportsAreEqual(base, {
        ...base,
        connection: { kind: "reconnecting", attempt: 2, attemptLimit: 5 },
      }),
    ).toBe(false);
  });

  it("sees the transport and the keystore move", () => {
    expect(mainProcessReportsAreEqual(base, { ...base, transport: "os-local" })).toBe(false);
    expect(mainProcessReportsAreEqual(base, { ...base, keystore: "available" })).toBe(false);
  });

  it("sees the Windows service lines move", () => {
    expect(mainProcessReportsAreEqual(base, { ...base, whileSignedOut: "passwordOutOfDate" })).toBe(
      false,
    );
    const exhausted: MainProcessState = {
      ...base,
      cannotStart: { reason: "restartsExhausted", error: "exit code 3" },
    };
    expect(mainProcessReportsAreEqual(exhausted, { ...exhausted })).toBe(true);
    // The error is word for word on screen, so a new one is a new report.
    expect(
      mainProcessReportsAreEqual(exhausted, {
        ...base,
        cannotStart: { reason: "restartsExhausted", error: "exit code 4" },
      }),
    ).toBe(false);
  });

  it("sees the handshake move", () => {
    const refused: MainProcessNegotiation = {
      compatible: false,
      daemonProtocolVersion: "2026-04-30",
      consoleProtocolVersion: "2026-08-14",
      daemonSupportedProtocols: ["2026-04-30"],
      reason: "version.ceiling_exceeded",
      behind: "app",
    };
    expect(mainProcessReportsAreEqual(base, { ...base, negotiation: refused })).toBe(false);
    // Which side is behind decides which update the page offers, so it alone is a new report.
    expect(
      mainProcessReportsAreEqual(
        { ...base, negotiation: refused },
        { ...base, negotiation: { ...refused, behind: "service" } },
      ),
    ).toBe(false);
  });
});
