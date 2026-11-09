// The machine's settings from the page's bridge, through main and the client helper, to the
// service and back: the read, the write answered with the file as written, a refusal the settings
// page reads, a change off its contract refused by the helper with nothing sent, and the feed,
// whose readings main checks against the settings contract.

import { setImmediate } from "node:timers/promises";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { JsonRpcError } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  MACHINE_SETTINGS_DEFAULTS,
  PROJECT_ENVIRONMENT_NAME_REFUSED_CODE,
  type ProjectEnvironmentNameRefusedDetails,
} from "@ai-sidekicks/contracts/machine/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import { bridgeOver, scriptedDaemon } from "./daemon.test-support.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

/** A row name the contract's own rule refuses. */
const REFUSED_NAME = "OPENAI_API_KEY";

/** The details the service sends with the refusal: the name, refused as credential-shaped. */
const REFUSED_DETAILS: ProjectEnvironmentNameRefusedDetails = {
  name: REFUSED_NAME,
  reason: "credentialShaped",
};

/** The service's refusal as its wire sends it: the contract's code, with the details as fields. */
const REFUSAL: JsonRpcError = {
  code: JsonRpcErrorCode.DomainRefusal,
  // The service's own words for a credential-shaped name, which no contract carries.
  message: "Credentials are not set here.",
  data: {
    type: PROJECT_ENVIRONMENT_NAME_REFUSED_CODE,
    category: "invalidArgument",
    fields: { ...REFUSED_DETAILS },
  },
};

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
});

describe("the machine's settings through main", () => {
  it("reads the file, writes a change answered with the file as written, and returns a refusal", async () => {
    const written = { ...MACHINE_SETTINGS_DEFAULTS, editorId: "zed" };
    let isRefusing = false;
    const daemon = scriptedDaemon((request) => {
      if (request.method === "machine.settings.read") {
        return { result: { settings: MACHINE_SETTINGS_DEFAULTS } };
      }
      return isRefusing ? { error: REFUSAL } : { result: { settings: written } };
    });
    const bridge = await bridgeOver(daemon);

    await expect(bridge.machineSettings.read()).resolves.toEqual({
      settings: MACHINE_SETTINGS_DEFAULTS,
    });
    await expect(bridge.machineSettings.write({ editorId: "zed" })).resolves.toEqual(written);
    isRefusing = true;
    await expect(bridge.machineSettings.write({ editorId: "zed" })).rejects.toEqual(REFUSAL);
    // A change off its contract is refused at the helper, before the service.
    await expect(bridge.machineSettings.write({ editorId: 7 } as never)).rejects.toMatchObject({
      data: { type: "request.paramsInvalid" },
    });
    expect(daemon.requests).toEqual([
      { method: "machine.settings.read", params: {} },
      { method: "machine.settings.update", params: { change: { editorId: "zed" } } },
      { method: "machine.settings.update", params: { change: { editorId: "zed" } } },
    ]);
  });

  it("delivers the feed's readings and ends it on one the contract refuses", async () => {
    const reading = { settings: MACHINE_SETTINGS_DEFAULTS };
    const daemon = scriptedDaemon(() => ({ result: { subscriptionId: "feed" } }));
    const bridge = await bridgeOver(daemon);
    const readings: unknown[] = [];
    const ends: unknown[] = [];

    bridge.machineSettings.subscribe(
      (delivered) => readings.push(delivered),
      (end) => ends.push(end),
    );
    await vi.waitFor(() => {
      expect(daemon.requests).toEqual([{ method: "machine.settings.subscribe", params: {} }]);
    });
    await setImmediate();
    daemon.notify("machine.settings.subscribe", reading);
    daemon.notify("machine.settings.subscribe", {
      settings: { ...MACHINE_SETTINGS_DEFAULTS, editorId: 7 },
    });

    await vi.waitFor(() => {
      expect(ends).toMatchObject([{ reason: "failed" }]);
    });
    expect(readings).toEqual([reading]);
  });
});
