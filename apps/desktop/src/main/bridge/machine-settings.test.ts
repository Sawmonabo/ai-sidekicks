// The machine's settings from the page's bridge, through main, to the service and back: the read,
// the write answered with the file as written, a refusal the settings page reads, and the feed,
// whose readings main checks against the settings contract.

import { setImmediate } from "node:timers/promises";

import { JsonRpcErrorCode, type JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/jsonrpc";
import {
  DAEMON_ENVIRONMENT_NAME_REFUSED_CODE,
  environmentNameRefusal,
  MACHINE_SETTINGS_DEFAULTS,
  type DaemonEnvironmentNameRefusedDetails,
  type MachineSettingsReading,
} from "@ai-sidekicks/contracts/machine-settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";
import { bridgeOver, scriptedConnection } from "./daemon.test-support.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const SUBSCRIPTION_ID = "6f4a0a43-6f1f-4b8f-9d50-2b0e4bb0b001";

/** A row name the contract's own rule refuses. */
const REFUSED_NAME = "OPENAI_API_KEY";

/** The details the service sends with the refusal, built from the contract's rule and type. */
const REFUSED_DETAILS: DaemonEnvironmentNameRefusedDetails = {
  name: REFUSED_NAME,
  reason: environmentNameRefusal(REFUSED_NAME) ?? expect.fail("the contract takes the name"),
};

/** The service's refusal as its wire sends it: the contract's code, with the details as fields. */
const REFUSAL: JsonRpcError = {
  code: JsonRpcErrorCode.InvalidParams,
  // The service's own words for a credential-shaped name, which no contract carries.
  message: "Credentials are not set here.",
  data: { type: DAEMON_ENVIRONMENT_NAME_REFUSED_CODE, fields: { ...REFUSED_DETAILS } },
};

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
});

describe("the machine's settings through main", () => {
  it("reads the file, writes a change answered with the file as written, and returns a refusal", async () => {
    const written = { ...MACHINE_SETTINGS_DEFAULTS, editorId: "zed" };
    const connection = scriptedConnection((request) => {
      if (request.method === "daemon.machineSettingsRead") {
        return { result: { settings: MACHINE_SETTINGS_DEFAULTS } };
      }
      const { change } = request.params as { readonly change: Record<string, unknown> };
      return "environmentRows" in change ? { error: REFUSAL } : { result: { settings: written } };
    });
    const bridge = await bridgeOver(connection);

    await expect(bridge.machineSettings.read()).resolves.toEqual({
      settings: MACHINE_SETTINGS_DEFAULTS,
    });
    await expect(bridge.machineSettings.write({ editorId: "zed" })).resolves.toEqual(written);
    await expect(
      bridge.machineSettings.write({
        environmentRows: [{ name: REFUSED_NAME, value: "sk-not-a-real-key" }],
      }),
    ).rejects.toEqual(REFUSAL);
    expect(connection.requests.map((request) => request.method)).toEqual([
      "daemon.machineSettingsRead",
      "daemon.machineSettingsUpdate",
      "daemon.machineSettingsUpdate",
    ]);
  });

  it("delivers the feed's readings and ends it on one the contract refuses", async () => {
    const reading: MachineSettingsReading = { settings: MACHINE_SETTINGS_DEFAULTS };
    const connection = scriptedConnection(() => ({ result: { subscriptionId: SUBSCRIPTION_ID } }));
    const bridge = await bridgeOver(connection);
    const readings: unknown[] = [];
    const ends: unknown[] = [];

    bridge.machineSettings.subscribe(
      (delivered) => readings.push(delivered),
      (end) => ends.push(end),
    );
    await setImmediate();
    connection.notify(SUBSCRIPTION_ID, reading);
    connection.notify(SUBSCRIPTION_ID, { settings: { ...MACHINE_SETTINGS_DEFAULTS, editorId: 7 } });
    await setImmediate();

    expect(readings).toEqual([reading]);
    expect(ends).toMatchObject([{ reason: "failed" }]);
    expect(connection.requests[0]).toEqual({
      method: "daemon.machineSettingsSubscribe",
      params: {},
    });
  });
});
