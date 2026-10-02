// The settings file's three verbs through the registry against a real file: a missing file reads
// as the defaults, a broken one is repaired and says so, a refused row writes nothing, and a
// listener hears the file as it stands first and each change after.
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  JsonRpcErrorCode,
  MACHINE_SETTINGS_DEFAULTS,
  MACHINE_SETTINGS_FILE_PATH_SEGMENTS,
  type JsonRpcNotification,
  type MachineSettingsReading,
  type MachineSettingsUpdateResponse,
  type SubscribeAckResponse,
  type SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts";

import { mapJsonRpcError } from "../../ipc/jsonrpc-error-mapping.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { StreamingPrimitive } from "../../ipc/streaming-primitive.js";
import { MachineSettingsFile } from "../machine-settings-file.js";
import { registerMachineSettingsMethods } from "../machine-settings-methods.js";

const REPAIRED_AT = new Date("2026-09-29T18:00:00.000Z");
const TRANSPORT_ID = 7;

let homeDirectory: string;
let settingsPath: string;
let registry: MethodRegistryImpl;
let send: ReturnType<
  typeof vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>
>;
let streamingPrimitive: StreamingPrimitive;
let settingsFile: MachineSettingsFile;

beforeEach(async () => {
  homeDirectory = await mkdtemp(join(tmpdir(), "machine-settings-"));
  settingsPath = join(homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS);
  registry = new MethodRegistryImpl();
  send = vi.fn<(transportId: number, frame: JsonRpcNotification<unknown>) => void>();
  streamingPrimitive = new StreamingPrimitive({ registry, send });
  settingsFile = new MachineSettingsFile({ filePath: settingsPath, now: () => REPAIRED_AT });
  registerMachineSettingsMethods(registry, { settingsFile, streamingPrimitive });
});

afterEach(async () => {
  await rm(homeDirectory, { recursive: true, force: true });
});

async function writeRawSettingsFile(text: string): Promise<void> {
  await mkdir(join(homeDirectory, MACHINE_SETTINGS_FILE_PATH_SEGMENTS[0]), { recursive: true });
  await writeFile(settingsPath, text, "utf8");
}

async function readSettingsFileJson(): Promise<unknown> {
  return JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
}

function notifiedReadings(): MachineSettingsReading[] {
  return send.mock.calls.map(
    ([, frame]) => (frame.params as SubscriptionNotifyParams<MachineSettingsReading>).value,
  );
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("daemon.machineSettingsRead", () => {
  it("reads a missing file as the defaults and leaves it missing", async () => {
    const reading = await registry.dispatch("daemon.machineSettingsRead", {}, {});
    expect(reading).toStrictEqual({ settings: MACHINE_SETTINGS_DEFAULTS });
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a file that is not JSON, owner-only, and says so until the next change", async () => {
    await writeRawSettingsFile("{ not json");

    const reading = await registry.dispatch("daemon.machineSettingsRead", {}, {});
    expect(reading).toStrictEqual({
      settings: MACHINE_SETTINGS_DEFAULTS,
      repair: { repairedAt: REPAIRED_AT.toISOString(), cause: "unparseable" },
    });
    expect(await readSettingsFileJson()).toStrictEqual(MACHINE_SETTINGS_DEFAULTS);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);

    const readAgain = (await registry.dispatch(
      "daemon.machineSettingsRead",
      {},
      {},
    )) as MachineSettingsReading;
    expect(readAgain.repair?.cause).toBe("unparseable");

    await registry.dispatch(
      "daemon.machineSettingsUpdate",
      { change: { screenReaderMode: true } },
      {},
    );
    const afterChange = (await registry.dispatch(
      "daemon.machineSettingsRead",
      {},
      {},
    )) as MachineSettingsReading;
    expect(afterChange.repair).toBeUndefined();
  });

  it("repairs a file the schema refuses", async () => {
    await writeRawSettingsFile(JSON.stringify({ voice: { mode: "push" } }));
    const reading = (await registry.dispatch(
      "daemon.machineSettingsRead",
      {},
      {},
    )) as MachineSettingsReading;
    expect(reading.repair?.cause).toBe("schemaRefused");
    expect(reading.settings).toStrictEqual(MACHINE_SETTINGS_DEFAULTS);
  });
});

describe("daemon.machineSettingsUpdate", () => {
  it("writes the change over the file and answers with the file as written", async () => {
    await writeRawSettingsFile(JSON.stringify({ keepAwakeWhileAgentWorks: true }));
    const rows = [{ name: "HTTPS_PROXY", value: "http://proxy.lan:3128" }];

    const response = (await registry.dispatch(
      "daemon.machineSettingsUpdate",
      { change: { environmentRows: rows } },
      {},
    )) as MachineSettingsUpdateResponse;

    const expected = {
      ...MACHINE_SETTINGS_DEFAULTS,
      keepAwakeWhileAgentWorks: true,
      environmentRows: rows,
    };
    expect(response.settings).toStrictEqual(expected);
    expect(await readSettingsFileJson()).toStrictEqual(expected);
  });

  it.each([
    ["ANTHROPIC_API_KEY", "credential_shaped"],
    ["DISABLE_AUTOUPDATER", "set_by_app"],
    ["NOT-A-NAME", "not_a_name"],
  ] as const)("refuses the row %s as %s and writes nothing", async (name, reason) => {
    const dispatched = registry.dispatch(
      "daemon.machineSettingsUpdate",
      {
        change: {
          environmentRows: [
            { name: "HTTPS_PROXY", value: "x" },
            { name, value: "x" },
          ],
        },
      },
      {},
    );
    const thrown: unknown = await dispatched.catch((error: unknown) => error);

    const envelope = mapJsonRpcError(thrown, 1);
    expect(envelope.error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(envelope.error.data).toMatchObject({
      type: "daemon.environment_name_refused",
      fields: { name, reason },
    });
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("daemon.machineSettingsSubscribe", () => {
  it("sends the file as it stands after the acknowledgement, then each change", async () => {
    await writeRawSettingsFile(JSON.stringify({ rememberSiteData: false }));

    const ack = (await registry.dispatch(
      "daemon.machineSettingsSubscribe",
      {},
      { transportId: TRANSPORT_ID },
    )) as SubscribeAckResponse;
    expect(send).not.toHaveBeenCalled();

    await nextTurn();
    expect(notifiedReadings()).toStrictEqual([
      { settings: { ...MACHINE_SETTINGS_DEFAULTS, rememberSiteData: false } },
    ]);
    expect(send.mock.calls[0]?.[0]).toBe(TRANSPORT_ID);
    expect(
      (send.mock.calls[0]?.[1].params as SubscriptionNotifyParams<MachineSettingsReading>)
        .subscriptionId,
    ).toBe(ack.subscriptionId);

    await registry.dispatch(
      "daemon.machineSettingsUpdate",
      { change: { voice: { mode: "tap", callVoice: null } } },
      {},
    );
    expect(notifiedReadings()[1]).toStrictEqual({
      settings: {
        ...MACHINE_SETTINGS_DEFAULTS,
        rememberSiteData: false,
        voice: { mode: "tap", callVoice: null },
      },
    });
  });

  it("detaches from the file and stops sending once the subscription is canceled", async () => {
    const detach = vi.fn<() => void>();
    const subscribeToFile = settingsFile.subscribe.bind(settingsFile);
    vi.spyOn(settingsFile, "subscribe").mockImplementation(async (listener) => {
      const unsubscribe = await subscribeToFile(listener);
      return () => {
        detach();
        unsubscribe();
      };
    });
    const ack = (await registry.dispatch(
      "daemon.machineSettingsSubscribe",
      {},
      { transportId: TRANSPORT_ID },
    )) as SubscribeAckResponse;
    await nextTurn();
    expect(send).toHaveBeenCalledTimes(1);

    await registry.dispatch(
      "$/subscription/cancel",
      { subscriptionId: ack.subscriptionId },
      { transportId: TRANSPORT_ID },
    );
    await registry.dispatch(
      "daemon.machineSettingsUpdate",
      { change: { screenReaderMode: true } },
      {},
    );
    expect(detach).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
