// The settings file's three verbs through the registry against a real file and the real git: a
// missing file reads as the defaults and is written with them, a broken one is repaired and says
// so, a refused row or branch-name pattern writes nothing and says why in the page's words, and a
// listener hears the file as it stands first and each change after.
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonRpcErrorCode, type JsonRpcNotification } from "@ai-sidekicks/contracts/jsonrpc";
import {
  MACHINE_SETTINGS_DEFAULTS,
  MACHINE_SETTINGS_FILE_PATH_SEGMENTS,
  type MachineSettingsReading,
  type MachineSettingsUpdateResponse,
} from "@ai-sidekicks/contracts/machine-settings";
import type {
  SubscribeAckResponse,
  SubscriptionNotifyParams,
} from "@ai-sidekicks/contracts/jsonrpc-streaming";

import { findBranchPatternRefusal } from "../../../git/branch-name-pattern.js";
import { mapJsonRpcError } from "../../../ipc/jsonrpc-error-mapping.js";
import { MethodRegistryImpl } from "../../../ipc/registry.js";
import { StreamingPrimitive } from "../../../ipc/streaming-primitive.js";
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
  registerMachineSettingsMethods(registry, {
    settingsFile,
    streamingPrimitive,
    findBranchPatternRefusal,
  });
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
  it("reads a missing file as the defaults and writes them, with no repair to tell", async () => {
    const reading = await registry.dispatch("daemon.machineSettingsRead", {}, {});
    expect(reading).toStrictEqual({ settings: MACHINE_SETTINGS_DEFAULTS });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toStrictEqual(
      MACHINE_SETTINGS_DEFAULTS,
    );
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
    [
      {
        environmentRows: [
          { name: "HTTPS_PROXY", value: "x" },
          { name: "ANTHROPIC_API_KEY", value: "x" },
        ],
      },
      "daemon.environment_name_refused",
      { name: "ANTHROPIC_API_KEY", reason: "credential_shaped" },
      "Credentials are not set here. Sign in to a provider on Providers, or add a workflow " +
        "step's token in its Credential field.",
    ],
    [
      { environmentRows: [{ name: "DISABLE_AUTOUPDATER", value: "x" }] },
      "daemon.environment_name_refused",
      { name: "DISABLE_AUTOUPDATER", reason: "set_by_app" },
      "The app sets this.",
    ],
    [
      { environmentRows: [{ name: "NOT-A-NAME", value: "x" }] },
      "daemon.environment_name_refused",
      { name: "NOT-A-NAME", reason: "not_a_name" },
      "A name is letters, digits and underscores, and never starts with a digit.",
    ],
    [
      { branchNamePattern: "sidekicks/{session}" },
      "daemon.branch_pattern_refused",
      { reason: "title_not_once" },
      "Put {title} in the name once.",
    ],
    [
      { branchNamePattern: "{title}/{title}" },
      "daemon.branch_pattern_refused",
      { reason: "title_not_once" },
      "Put {title} in the name once.",
    ],
    [
      { branchNamePattern: "{session}/{session}/{title}" },
      "daemon.branch_pattern_refused",
      { reason: "session_not_once" },
      "A branch-name pattern holds {session} at most once.",
    ],
    [
      { branchNamePattern: "sidekicks..{title}" },
      "daemon.branch_pattern_refused",
      { reason: "not_a_branch_name" },
      "Git does not accept this as a branch name.",
    ],
    [
      { branchNamePattern: "-{title}" },
      "daemon.branch_pattern_refused",
      { reason: "not_a_branch_name" },
      "Git does not accept this as a branch name.",
    ],
  ] as const)("refuses %j as %s and writes nothing", async (change, type, fields, words) => {
    const thrown: unknown = await registry
      .dispatch("daemon.machineSettingsUpdate", { change }, {})
      .catch((error: unknown) => error);

    const envelope = mapJsonRpcError(thrown, 1);
    expect(envelope.error).toEqual({
      code: JsonRpcErrorCode.InvalidParams,
      message: words,
      data: { type, fields },
    });
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("negative control: writes a pattern git accepts", async () => {
    await registry.dispatch(
      "daemon.machineSettingsUpdate",
      { change: { branchNamePattern: "sawmon/{title}" } },
      {},
    );
    expect(await readSettingsFileJson()).toMatchObject({ branchNamePattern: "sawmon/{title}" });
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
