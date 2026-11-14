// This device's presence reaches the background service when the link comes up, at once when the
// app leaves or regains the front (a lock counting as leaving it), and every 15 seconds otherwise.

import { EventEmitter } from "node:events";

import {
  validatePresenceHeartbeatSendRequest,
  type PresenceHeartbeatSendRequest,
} from "@ai-sidekicks/contracts/presence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MainDaemonClient } from "./daemon/client/process.js";
import { DaemonLink, unlinkedState } from "./daemon/link/status.js";
import { PresenceHeartbeat, type PresenceHeartbeatDependencies } from "./presence-heartbeat.js";

/** A daemon client that records each heartbeat it is sent. */
function createClient(): {
  readonly client: MainDaemonClient;
  readonly heartbeats: PresenceHeartbeatSendRequest[];
} {
  const heartbeats: PresenceHeartbeatSendRequest[] = [];
  const client = {
    call: (method: string, params: unknown) => {
      expect(method).toBe("presence.heartbeat.send");
      if (!validatePresenceHeartbeatSendRequest(params)) {
        throw new Error("the heartbeat breaks its contract");
      }
      heartbeats.push(params);
      return Promise.resolve({});
    },
  } as unknown as MainDaemonClient;
  return { client, heartbeats };
}

describe("PresenceHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends appVisible false at once when the window loses the front or the screen locks", () => {
    const app = new EventEmitter();
    const powerMonitor = Object.assign(new EventEmitter(), {
      getSystemIdleState: () => "active" as const,
    });
    const focus = { isAnyWindowFocused: true };
    const link = new DaemonLink();
    const logged: string[] = [];
    new PresenceHeartbeat({
      app: app as unknown as PresenceHeartbeatDependencies["app"],
      powerMonitor: powerMonitor as unknown as PresenceHeartbeatDependencies["powerMonitor"],
      isAnyWindowFocused: () => focus.isAnyWindowFocused,
      daemonLink: link,
      logWarning: (message) => logged.push(message),
    });
    const { client, heartbeats } = createClient();
    link.attach(client, unlinkedState({ kind: "connected" }));
    expect(heartbeats.map((heartbeat) => heartbeat.appVisible)).toStrictEqual([true]);

    focus.isAnyWindowFocused = false;
    app.emit("browser-window-blur");
    expect(heartbeats.map((heartbeat) => heartbeat.appVisible)).toStrictEqual([true, false]);

    // A blur that changes nothing sends nothing; the beat repeats the fact every 15 seconds.
    app.emit("browser-window-blur");
    vi.advanceTimersByTime(15_000);
    expect(heartbeats.map((heartbeat) => heartbeat.appVisible)).toStrictEqual([true, false, false]);

    focus.isAnyWindowFocused = true;
    app.emit("browser-window-focus");
    powerMonitor.emit("lock-screen");
    expect(heartbeats.map((heartbeat) => heartbeat.appVisible)).toStrictEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(heartbeats.every((heartbeat) => heartbeat.deviceType === "desktop")).toBe(true);

    // With the link gone nothing is sent, and the beat stops.
    link.detach(unlinkedState({ kind: "connecting" }));
    powerMonitor.emit("unlock-screen");
    vi.advanceTimersByTime(60_000);
    expect(heartbeats).toHaveLength(5);
    expect(logged).toStrictEqual([]);
  });
});
