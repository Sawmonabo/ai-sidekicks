// The bridge treats every page payload as untrusted. Intake parity: a payload outside a member's
// contract never passes main, so its act never runs and nothing reaches the service, while one
// inside it does. The subscribe channel opens only the daemon streams the app opens, so a page
// cannot reach a daemon method by naming it as a stream.
//
// Every channel that carries a payload has a case. The ones that carry none are left out:
// `native.listEditors`, `native.getNotificationPermission`, `keyboardMap.read`,
// `machineSettings.read`, `window.readAppearance`, `window.endSafeStart` and `daemon.requestStart`
// read nothing from the page. Each case sends what crosses IPC itself, past the preload, as a page
// that got around it would; the two daemon-backed members go through the page's bridge, which
// turns main's failed answer into a rejection.

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import {
  MACHINE_SETTINGS_DEFAULTS,
  MachineSettingsChangeSchema,
  MachineSettingsSubscribeRequestSchema,
} from "@ai-sidekicks/contracts/machine-settings";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

import {
  BRIDGE_CHANNELS,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
  type InvokedBridgeChannel,
} from "#shared/bridge-channels.js";
import { DEFAULT_APPEARANCE_RECORD, MERIDIAN_GROUNDS } from "#shared/appearance.js";
import type { DaemonSubscriptionRequest } from "#shared/daemon/forwarding.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";
import {
  bridgeOverLink,
  linkOver,
  scriptedConnection,
  type ScriptedConnection,
} from "./daemon.test-support.js";
import type { WindowHandlerContext } from "./window-handlers.js";

const electronMock = createElectronMock();

/** What the platform's dialog, clipboard and file manager were asked to do, in order. */
const dialogOpens: unknown[] = [];
const clipboardWrites: unknown[] = [];
const revealedPaths: string[] = [];

// The shared mock carries no dialog, clipboard or file-manager reveal; these record each ask.
vi.mock("electron", () => ({
  ...electronMock.moduleExports,
  shell: {
    ...(electronMock.moduleExports["shell"] as object),
    showItemInFolder: (target: string) => {
      revealedPaths.push(target);
    },
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => {
      dialogOpens.push(args.at(-1));
      return Promise.resolve({ canceled: true, filePaths: [] });
    },
  },
  clipboard: {
    write: (items: unknown) => {
      clipboardWrites.push(items);
    },
  },
  ClipboardItem: class {
    public constructor(public readonly flavors: unknown) {}
  },
}));

const SESSION_ID = "00000000-0000-4000-8000-000000000001" as SessionId;

/** The file a served `session.memoryRead` offers to open. */
const MEMORY_FILE = "/Users/person/.claude/projects/app/CLAUDE.md";

/** The id the daemon acknowledges a `session.subscribe` under. */
const DAEMON_SUBSCRIPTION_ID = randomUUID();

/** One member's payloads outside its contract, one inside it, and what its act did. */
interface IntakeCase {
  readonly member: string;
  /** The contract's schema, where one is written, which must refuse each refused payload too. */
  readonly contract?: ZodType;
  readonly refused: readonly unknown[];
  /** What main answers each refused payload with, where it is one message. */
  readonly refusal?: string;
  readonly accepted: unknown;
  send(payload: unknown): Promise<unknown>;
  /** How many times the member's act has run, or what it left behind. */
  acted(): unknown;
}

let connection: ScriptedConnection;
let bridge: PreloadApi;
let userData: string;
/** The appearance choices and default sizes main's window owner was handed. */
let appearanceChoices: unknown[];
let defaultSizes: unknown[];
/** The minimum sizes the one open window was given. */
let minimumSizes: unknown[];

beforeEach(async () => {
  electronMock.reset();
  vi.resetModules();
  dialogOpens.length = 0;
  clipboardWrites.length = 0;
  revealedPaths.length = 0;
  minimumSizes = [];
  appearanceChoices = [];
  defaultSizes = [];
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-adversarial-boundary-"));
  connection = scriptedConnection((request) => {
    switch (request.method) {
      case "session.memoryRead":
        return {
          result: {
            sessionId: SESSION_ID,
            home: "/Users/person/.claude",
            autoMemory: { enabled: true },
            entries: [{ path: MEMORY_FILE, kind: "file" }],
          },
        };
      case "presence.read":
        return { result: { devices: [] } };
      case "session.subscribe":
        return { result: { subscriptionId: DAEMON_SUBSCRIPTION_ID } };
      case "$/subscription/cancel":
        return { result: { canceled: true } };
      default:
        return { result: { settings: MACHINE_SETTINGS_DEFAULTS } };
    }
  });
  const windowContext: WindowHandlerContext = {
    appearance: {
      choose: (choice, grounds) => {
        appearanceChoices.push({ choice, grounds });
        return Promise.resolve();
      },
      record: DEFAULT_APPEARANCE_RECORD,
    },
    openWindows: {
      windowWithId: () =>
        ({
          getBounds: () => ({ x: 0, y: 25, width: 1200, height: 800 }),
          setMinimumSize: (width: number, height: number) => {
            minimumSizes.push([width, height]);
          },
        }) as never,
      isConsoleDocument: () => true,
      windowUsedLast: () => undefined,
      setDefaultSizes: (sizes) => {
        defaultSizes.push(sizes);
      },
      endSafeStart: () => undefined,
    },
  };
  bridge = await bridgeOverLink(await linkOver(connection), userData, windowContext);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

/** Send `payload` on `channel` as the page's IPC would, past the preload. */
function invoke(channel: InvokedBridgeChannel, payload: unknown): Promise<unknown> {
  const { ipcRenderer } = electronMock.moduleExports as {
    ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
  };
  return ipcRenderer.invoke(channel, payload);
}

/** Open a daemon subscription on the synchronous channel as the page's IPC would. */
function openSubscription(request: DaemonSubscriptionRequest): unknown {
  const { ipcRenderer } = electronMock.moduleExports as {
    ipcRenderer: { sendSync(channel: string, ...args: unknown[]): unknown };
  };
  return ipcRenderer.sendSync(OPEN_DAEMON_SUBSCRIPTION_CHANNEL, request);
}

/** A token to open the memory file, as a served `session.memoryRead` hands it to the page. */
async function openToken(): Promise<string> {
  const served = (await invoke(BRIDGE_CHANNELS.daemonCall, {
    method: "session.memoryRead",
    params: { sessionId: SESSION_ID },
  })) as { readonly fileRefs: Readonly<Record<string, string>> };
  return served.fileRefs[MEMORY_FILE] ?? expect.fail("the read offered no token");
}

/** Whether main refused: the call rejected, or main answered it as failed. */
async function isRefused(answer: Promise<unknown>): Promise<boolean> {
  try {
    const value = await answer;
    return (value as { outcome?: unknown } | undefined)?.outcome === "failed";
  } catch {
    return true;
  }
}

/** The pictures main has kept in its paste folder. */
async function pastedPictures(): Promise<string[]> {
  return readdir(path.join(userData, "pasted-images")).catch(() => []);
}

/** The cases whose accepted payload is built in the case: a token, a real file. */
async function intakeCases(): Promise<readonly IntakeCase[]> {
  const droppedFile = path.join(userData, "dropped.txt");
  await writeFile(droppedFile, "dropped");
  // A token main minted to attach the file, which no verb that opens a path takes.
  const attachToken = await invoke(BRIDGE_CHANNELS.getDroppedFileRef, droppedFile);
  const droppedTokens: unknown[] = [];
  const appearance = {
    choice: { theme: "graphite", scheme: "dark", textSize: 18, transcriptWidth: 44 },
    grounds: MERIDIAN_GROUNDS,
  };
  return [
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
      accepted: { editorId: "zed" },
      send: (payload) => bridge.machineSettings.write(payload as never),
      acted: () => connection.requests.length,
    },
    {
      member: "the machine settings feed",
      contract: MachineSettingsSubscribeRequestSchema,
      refused: [{ everyDevice: true }, "all", null],
      refusal: "The daemon.machineSettingsSubscribe request does not match its contract.",
      accepted: {},
      send: async (payload) =>
        bridge.daemon.subscribe(
          "daemon.machineSettingsSubscribe" as never,
          payload as never,
          () => undefined,
        ),
      acted: () => connection.requests.length,
    },
    {
      member: "daemon.call",
      refused: [
        { method: "session.read", params: { sessionId: 7 } },
        { method: "daemon.machineSettingsUpdate", params: { change: { editorId: 7 } } },
        { method: 7, params: {} },
        "session.read",
        null,
      ],
      accepted: { method: "presence.read", params: {} },
      send: (payload) => invoke(BRIDGE_CHANNELS.daemonCall, payload),
      acted: () => connection.requests.length,
    },
    {
      member: "native.showOpenDialog",
      refused: [{ purpose: "exportFile" }, { purpose: 7 }, "attachFiles", {}, null],
      accepted: { purpose: "attachFiles" },
      send: (payload) => invoke(BRIDGE_CHANNELS.showOpenDialog, payload),
      acted: () => dialogOpens.length,
    },
    {
      member: "native.getDroppedFileRef",
      refused: [7, "dropped.txt", "", userData, path.join(userData, "missing.txt"), null],
      accepted: droppedFile,
      send: async (payload) => {
        droppedTokens.push(await invoke(BRIDGE_CHANNELS.getDroppedFileRef, payload));
      },
      acted: () => droppedTokens.length,
    },
    {
      member: "native.savePastedImage",
      refused: [new ArrayBuffer(0), new Uint8Array([137, 80]), [137, 80], "iVBORw0KGgo=", null],
      accepted: new Uint8Array([137, 80, 78, 71]).buffer,
      send: (payload) => invoke(BRIDGE_CHANNELS.savePastedImage, payload),
      acted: pastedPictures,
    },
    {
      member: "native.openExternal",
      refused: ["file:///etc/passwd", "javascript:alert(1)", "sidekicks-renderer://app/", 7, null],
      accepted: "https://example.com/",
      send: (payload) => invoke(BRIDGE_CHANNELS.openExternal, payload),
      acted: () => electronMock.externalOpens.length,
    },
    {
      member: "native.openInEditor",
      refused: [
        { ref: MEMORY_FILE },
        { ref: attachToken },
        { ref: "the-token", line: 0 },
        "the-token",
        null,
      ],
      accepted: { ref: "the-token" },
      send: async (payload) => invoke(BRIDGE_CHANNELS.openInEditor, await withToken(payload)),
      acted: () => electronMock.pathOpens.length,
    },
    {
      member: "native.copyToClipboard",
      refused: [{ text: 7 }, { html: "<b>a</b>" }, { text: "a", html: 7 }, "a", null],
      accepted: { text: "a", html: "<b>a</b>" },
      send: (payload) => invoke(BRIDGE_CHANNELS.copyToClipboard, payload),
      acted: () => clipboardWrites.length,
    },
    {
      member: "native.revealInFileExplorer",
      refused: [MEMORY_FILE, attachToken, randomUUID(), 7, null],
      accepted: "the-token",
      send: async (payload) =>
        invoke(BRIDGE_CHANNELS.revealInFileExplorer, await withToken(payload)),
      acted: () => revealedPaths.length,
    },
    {
      member: "keyboardMap.write",
      refused: [{ "frame.goToSessions": 7 }, "Mod+1", [], null],
      accepted: { "frame.goToSessions": "Mod+1" },
      send: (payload) => invoke(BRIDGE_CHANNELS.writeKeyboardMap, payload),
      acted: async () => ((await bridge.keyboardMap.read()) as { map: object }).map,
    },
    {
      member: "window.setAppearance",
      refused: [
        { ...appearance, choice: { ...appearance.choice, theme: "neon" } },
        { ...appearance, choice: { ...appearance.choice, textSize: 17 } },
        { ...appearance, grounds: { light: "white", dark: MERIDIAN_GROUNDS.dark } },
        { ...appearance, extra: true },
        appearance.choice,
        null,
      ],
      accepted: appearance,
      send: (payload) => invoke(BRIDGE_CHANNELS.setAppearance, payload),
      acted: () => appearanceChoices.length,
    },
    {
      member: "window.setMinimumSize",
      refused: [
        { windowId: "w-1", size: { width: 0, height: 400 } },
        { windowId: "w-1", size: { width: -1, height: 400 } },
        { windowId: "w-1", size: { width: "600", height: 400 } },
        { windowId: 7, size: { width: 600, height: 400 } },
        { windowId: "w-1", size: { width: 600, height: 400 }, extra: true },
        null,
      ],
      accepted: { windowId: "w-1", size: { width: 600, height: 400 } },
      send: (payload) => invoke(BRIDGE_CHANNELS.setMinimumSize, payload),
      acted: () => minimumSizes.length,
    },
    {
      member: "window.setDefaultSizes",
      refused: [
        { paneWidths: { sessions: 0 } },
        { paneWidths: { sessions: "300" } },
        { paneWidths: {}, extra: true },
        {},
        null,
      ],
      accepted: { paneWidths: { sessions: 300 } },
      send: (payload) => invoke(BRIDGE_CHANNELS.setDefaultSizes, payload),
      acted: () => defaultSizes.length,
    },
  ];
}

/** `payload` with each `"the-token"` replaced by a token main minted to open the memory file. */
async function withToken(payload: unknown): Promise<unknown> {
  if (payload === "the-token") {
    return openToken();
  }
  if (typeof payload === "object" && payload !== null && "ref" in payload) {
    return payload.ref === "the-token" ? { ...payload, ref: await openToken() } : payload;
  }
  return payload;
}

describe("intake parity", () => {
  it("refuses in main every payload outside each member's contract, and takes one inside it", async () => {
    for (const intake of await intakeCases()) {
      const before = await intake.acted();
      const requestsBefore = connection.requests.length;
      for (const payload of intake.refused) {
        const named = `${intake.member} ${JSON.stringify(payload)}`;
        if (intake.contract !== undefined) {
          expect(intake.contract.safeParse(payload).success, named).toBe(false);
        }
        if (intake.refusal === undefined) {
          expect(await isRefused(intake.send(payload)), named).toBe(true);
        } else {
          await expect(intake.send(payload), named).rejects.toThrow(intake.refusal);
        }
        expect(await intake.acted(), named).toStrictEqual(before);
      }
      // Minting a token reads the memory file's reply; nothing a refused payload carried is sent.
      const sentByRefused = connection.requests
        .slice(requestsBefore)
        .filter((request) => request.method !== "session.memoryRead");
      expect(sentByRefused, intake.member).toEqual([]);

      // Negative control: a payload inside the contract is taken and acted on.
      expect(await isRefused(intake.send(intake.accepted)), intake.member).toBe(false);
      await setImmediate();
      expect(await intake.acted(), intake.member).not.toStrictEqual(before);
    }
  });

  it("refuses a status topic opened with a request, and a subscription with no new id", () => {
    expect(() =>
      bridge.daemon.subscribe(
        "daemon.status",
        { sessionId: randomUUID() } as never,
        () => undefined,
      ),
    ).toThrow("The daemon.status topic is opened with nothing.");

    expect(openSubscription({ subscriptionId: "1", event: "daemon.status", params: {} })).toEqual({
      outcome: "failed",
      message: "A daemon subscription is opened with a new id, an event name and its request.",
    });
    expect(connection.requests).toEqual([]);
  });

  it("opens only the daemon streams the app opens, sending nothing for any other method", async () => {
    for (const [event, params] of [
      ["daemon.stop", {}],
      ["session.attachmentAdd", { sessionId: SESSION_ID, items: [{ path: "/etc/passwd" }] }],
    ] as const) {
      expect(openSubscription({ subscriptionId: randomUUID(), event, params }), event).toEqual({
        outcome: "failed",
        message: `The app does not subscribe to ${event}.`,
      });
    }
    await setImmediate();
    expect(connection.requests).toEqual([]);

    // Negative control: a stream the app opens is opened on the daemon, and closes by its id.
    const subscriptionId = randomUUID();
    expect(
      openSubscription({
        subscriptionId,
        event: "session.subscribe",
        params: { sessionId: SESSION_ID },
      }),
    ).toEqual({ outcome: "opened" });
    await setImmediate();
    expect(connection.requests.map((request) => request.method)).toEqual(["session.subscribe"]);

    for (const refusedId of [7, "not-an-id", null]) {
      await expect(invoke(BRIDGE_CHANNELS.closeDaemonSubscription, refusedId)).rejects.toThrow();
    }
    await invoke(BRIDGE_CHANNELS.closeDaemonSubscription, subscriptionId);
    await setImmediate();
    expect(connection.requests.map((request) => request.method)).toEqual([
      "session.subscribe",
      "$/subscription/cancel",
    ]);
  });
});
