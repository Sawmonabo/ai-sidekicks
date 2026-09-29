// What the main process reported, and whether two reports say the same thing.

import { describe, expect, it } from "vitest";

import {
  describeDaemonConnection,
  mainProcessReportsAreEqual,
  type MainProcessState,
} from "./main-process-state.js";
import { REPORTED_CONNECTIONS } from "@test/helpers/main-process-states.js";

describe("describeDaemonConnection", () => {
  it("answers a non-empty sentence for every supervisor state", () => {
    const described = new Set<string>();
    for (const connection of [{ kind: "unreported" } as const, ...REPORTED_CONNECTIONS]) {
      const sentence = describeDaemonConnection(connection);
      expect(sentence.length, connection.kind).toBeGreaterThan(0);
      described.add(sentence);
    }
    // Distinct per state: two states sharing a sentence is a state a person cannot
    // tell they are in.
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
  };

  it("holds two identical reports equal across object identity", () => {
    expect(mainProcessReportsAreEqual(base, { ...base, connection: { ...base.connection } })).toBe(
      true,
    );
  });

  it("sees the attempt move", () => {
    // The one that matters: a ladder that advanced is a different report, and a
    // comparison that missed it would freeze the count on screen at its first value.
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

  it("sees the handshake move", () => {
    expect(
      mainProcessReportsAreEqual(base, {
        ...base,
        negotiation: {
          compatible: false,
          daemonProtocolVersion: "2026-04-30",
          consoleProtocolVersion: "2026-08-14",
          daemonSupportedProtocols: ["2026-04-30"],
          reason: "version.ceiling_exceeded",
        },
      }),
    ).toBe(false);
  });
});
