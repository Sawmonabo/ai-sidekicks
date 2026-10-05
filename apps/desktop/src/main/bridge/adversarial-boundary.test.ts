// The bridge treats every page payload as untrusted. Intake parity: a payload the member's contract
// schema refuses never passes main, and nothing reaches the service. Mutation isolation: what
// crosses is a copy in both directions, so a page that changes what it sent or what it was handed
// changes nothing main holds.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MACHINE_SETTINGS_DEFAULTS,
  MachineSettingsChangeSchema,
  MachineSettingsSubscribeRequestSchema,
} from "@ai-sidekicks/contracts/machine-settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

import { OPEN_DAEMON_SUBSCRIPTION_CHANNEL } from "#shared/bridge-channels.js";
import type { DaemonSubscriptionRequest } from "#shared/daemon/forwarding.js";
import type { MainProcessState } from "#shared/daemon/daemon-status-topic.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";
import {
  bridgeOverLink,
  linkOver,
  scriptedConnection,
  stateReading,
  type ScriptedConnection,
} from "./daemon.test-support.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

/** One member's contract and the payloads it refuses, sent as the page would send them. */
interface IntakeCase {
  readonly member: string;
  readonly contract: ZodType;
  readonly refused: readonly unknown[];
  /** What main answers each refused payload with. */
  readonly refusal: string;
  send(bridge: PreloadApi, payload: unknown): Promise<unknown>;
}

const INTAKE_CASES: readonly IntakeCase[] = [
  {
    member: "machineSettings.write",
    contract: MachineSettingsChangeSchema,
    refused: [
      { editorId: 7 },
      { notASetting: true },
      { environmentRows: [{ name: "", value: "x" }] },
      "editorId",
      null,
      [],
    ],
    refusal: "Request params for daemon.machineSettingsUpdate failed schema validation",
    send: (bridge, payload) => bridge.machineSettings.write(payload as never),
  },
  {
    member: "the machine settings feed",
    contract: MachineSettingsSubscribeRequestSchema,
    refused: [{ everyDevice: true }, "all", null],
    refusal: "The daemon.machineSettingsSubscribe request does not match its contract.",
    send: async (bridge, payload) =>
      bridge.daemon.subscribe(
        "daemon.machineSettingsSubscribe" as never,
        payload as never,
        () => undefined,
      ),
  },
];

let connection: ScriptedConnection;
let bridge: PreloadApi;
let userData: string;

beforeEach(async () => {
  electronMock.reset();
  vi.resetModules();
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-adversarial-boundary-"));
  connection = scriptedConnection(() => ({ result: { settings: MACHINE_SETTINGS_DEFAULTS } }));
  bridge = await bridgeOverLink(await linkOver(connection), userData);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("intake parity", () => {
  for (const intake of INTAKE_CASES) {
    it(`refuses in main every ${intake.member} payload its contract refuses`, async () => {
      for (const payload of intake.refused) {
        expect(intake.contract.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
        await expect(intake.send(bridge, payload), JSON.stringify(payload)).rejects.toThrow(
          intake.refusal,
        );
      }
      expect(connection.requests).toEqual([]);
    });
  }

  it("refuses a status topic opened with a request, and a subscription with no new id", () => {
    expect(() =>
      bridge.daemon.subscribe(
        "daemon.status",
        { sessionId: randomUUID() } as never,
        () => undefined,
      ),
    ).toThrow("The daemon.status topic is opened with nothing.");
    const openSubscription = electronMock.ipcListeners.get(OPEN_DAEMON_SUBSCRIPTION_CHANNEL);
    const event = {
      senderFrame: { url: "sidekicks-renderer://app/index.html" },
      sender: { id: 1, send: vi.fn(), on: vi.fn(), once: vi.fn() },
      returnValue: undefined,
    };
    if (openSubscription === undefined) {
      throw new Error(`nothing answers ${OPEN_DAEMON_SUBSCRIPTION_CHANNEL}`);
    }
    const request: DaemonSubscriptionRequest = {
      subscriptionId: "1",
      event: "daemon.status",
      params: {},
    };
    openSubscription(event as never, request as never);
    expect(event.returnValue).toMatchObject({ outcome: "failed" });
    expect(connection.requests).toEqual([]);
  });

  it("negative control: forwards a change the contract takes", async () => {
    await expect(bridge.machineSettings.write({ editorId: "zed" })).resolves.toEqual(
      MACHINE_SETTINGS_DEFAULTS,
    );
    expect(connection.requests).toEqual([
      { method: "daemon.machineSettingsUpdate", params: { change: { editorId: "zed" } } },
    ]);
  });
});

describe("mutation isolation", () => {
  it("keeps what main holds when the page changes what it sent or what it was handed", async () => {
    const sent: Record<string, string | null> = { "frame.goToSessions": "Mod+1" };
    const stored = await bridge.keyboardMap.write(sent);
    sent["frame.goToSessions"] = "Mod+9";
    (stored as Record<string, string | null>)["frame.goToSessions"] = "Mod+8";
    const read = await bridge.keyboardMap.read();
    (read.map as Record<string, string | null>)["frame.goToSessions"] = "Mod+7";

    await expect(bridge.keyboardMap.read()).resolves.toStrictEqual({
      map: { "frame.goToSessions": "Mod+1" },
    });
  });

  it("keeps the link's state when the page changes the state it was delivered", async () => {
    const { DaemonLink } = await import("../services/daemon/daemon-link.js");
    const link = new DaemonLink();
    // A bridge of its own, over a link with no service, in place of the one every case starts on.
    electronMock.reset();
    const pageBridge = await bridgeOverLink(link, userData);
    link.report(stateReading({ kind: "starting" }));
    const delivered: MainProcessState[] = [];

    pageBridge.daemon.subscribe("daemon.status", {}, (state) => delivered.push(state));
    (delivered[0] as { connection: unknown }).connection = { kind: "connected" };

    expect(link.state.connection).toStrictEqual({ kind: "starting" });
  });
});
