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
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ZodType } from "zod";

import {
  BRIDGE_CHANNELS,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
  type InvokedBridgeChannel,
} from "#shared/bridge-channels.js";
import { DEFAULT_APPEARANCE_RECORD, THEME_GROUNDS } from "#shared/appearance.js";
import {
  REQUEST_UNSENDABLE_MESSAGE,
  type DaemonSubscriptionRequest,
} from "#shared/daemon/forwarding.js";
import type { ClipboardSnapshot, PreloadApi } from "#shared/preload-api.js";
import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import {
  bridgeOverLink,
  linkOver,
  scriptedConnection,
  type ScriptedConnection,
} from "./daemon.test-support.js";
import { describeFailure } from "#shared/failure-message.js";
import { PASTED_IMAGES_FOLDER_NAME } from "./native/file-intake.js";
import type { WindowHandlerContext } from "./window.js";

const electronMock = createElectronMock();

/** What the platform's dialog, clipboard and file manager were asked to do, in order. */
const dialogOpens: unknown[] = [];
const clipboardWrites: unknown[] = [];
const clipboardReads: unknown[] = [];
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
    // Holds the text every accepted formatting request names, so an accepted one writes, read as
    // text or from its one entry as each system reads it.
    readText: () => Promise.resolve("a"),
    read: () => {
      clipboardReads.push("read");
      return Promise.resolve([
        { types: ["text/plain"], getType: () => Promise.resolve(new Blob(["a"])) },
      ]);
    },
  },
  ClipboardItem: class {
    public constructor(public readonly flavors: unknown) {}
  },
}));

const SESSION_ID = "00000000-0000-4000-8000-000000000001" as SessionId;

/** The file a served `session.memoryRead` offers to open. */
const MEMORY_FILE = "/Users/person/.claude/projects/app/CLAUDE.md";

/** A digest of the right shape for a payload refused before any clipboard is read. */
const ANY_DIGEST = "0";

/** A refusal from a member's schema: a Zod issue list, never a runtime error from main's code. */
const SCHEMA_REFUSAL = /"code": "[a-z_]+"/;

/** The id the daemon acknowledges a `session.subscribe` under. */
const DAEMON_SUBSCRIPTION_ID = randomUUID();

/** One member's payloads outside its contract, one inside it, and what its act did. */
interface IntakeCase {
  readonly member: string;
  /** The contract's schema, where one is written, which must refuse each refused payload too. */
  readonly contract?: ZodType;
  readonly refused: readonly unknown[];
  /** What main refuses each refused payload with: its one message, or what its messages match. */
  readonly refusal: string | RegExp;
  readonly accepted: unknown;
  send(payload: unknown): Promise<unknown>;
  /** How many times the member's act has run, or what it left behind. */
  acted(): unknown;
}

/** One case's bridge over a scripted daemon, and what main's window owner was asked to do. */
interface BoundarySubject {
  readonly connection: ScriptedConnection;
  readonly bridge: PreloadApi;
  /** The app's data folder, removed when the test finishes. */
  readonly userData: string;
  readonly windowActs: WindowActs;
}

/** What main's window owner was handed and asked for, in order. */
interface WindowActs {
  /** The appearance choices and default sizes main's window owner was handed. */
  readonly appearanceChoices: unknown[];
  readonly defaultSizes: unknown[];
  /** The minimum sizes the one open window was given. */
  readonly minimumSizes: unknown[];
  /** How many pastes the one open window's document was asked for. */
  pastes: number;
  /** How many times the one open window was brought forward. */
  windowsBroughtForward: number;
}

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
  dialogOpens.length = 0;
  clipboardWrites.length = 0;
  revealedPaths.length = 0;
});

/** The page's bridge over main's real handlers, its daemon scripted, for the running test. */
async function openBoundary(): Promise<BoundarySubject> {
  const windowActs: WindowActs = {
    appearanceChoices: [],
    defaultSizes: [],
    minimumSizes: [],
    pastes: 0,
    windowsBroughtForward: 0,
  };
  const userData = await mkdtemp(path.join(tmpdir(), "sidekicks-adversarial-boundary-"));
  onTestFinished(async () => {
    await rm(userData, { recursive: true, force: true });
  });
  const connection = scriptedConnection((request) => {
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
        windowActs.appearanceChoices.push({ choice, grounds });
        return Promise.resolve();
      },
      record: DEFAULT_APPEARANCE_RECORD,
    },
    openWindows: {
      windowWithId: () =>
        ({
          getBounds: () => ({ x: 0, y: 25, width: 1200, height: 800 }),
          // The window never moves or closes here.
          on: () => undefined,
          once: () => undefined,
          setMinimumSize: (width: number, height: number) => {
            windowActs.minimumSizes.push([width, height]);
          },
          isMinimized: () => false,
          restore: () => undefined,
          show: () => undefined,
          showInactive: () => undefined,
          focus: () => {
            windowActs.windowsBroughtForward += 1;
          },
        }) as never,
      documentOfWindow: () =>
        ({
          isDestroyed: () => false,
          paste: () => {
            windowActs.pastes += 1;
          },
        }) as never,
      isConsoleDocument: () => true,
      windowUsedLast: () => undefined,
      setDefaultSizes: (sizes) => {
        windowActs.defaultSizes.push(sizes);
      },
      endSafeStart: () => undefined,
      readNavigationRequest: () => null,
    },
  };
  const bridge = await bridgeOverLink(await linkOver(connection), userData, windowContext);
  return { connection, bridge, userData, windowActs };
}

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

/** Why main refused: the call's rejection, or the message main answered it as failed with. */
async function refusalOf(answer: Promise<unknown>): Promise<string | undefined> {
  try {
    const value = (await answer) as { outcome?: unknown; message?: unknown } | undefined;
    if (value?.outcome === "unsendable") {
      // The words the page reads for it.
      return REQUEST_UNSENDABLE_MESSAGE;
    }
    return value?.outcome === "failed" ? String(value.message) : undefined;
  } catch (error: unknown) {
    return describeFailure(error);
  }
}

/** Sends main a late copy's first and only text piece, under `copyId`. */
async function sendTextPiece(copyId: string): Promise<void> {
  await invoke(BRIDGE_CHANNELS.sendClipboardPiece, {
    copyId,
    flavor: "text",
    index: 0,
    piece: "a",
  });
}

/** The digest main's snapshot reads of what the clipboard holds now. */
async function heldDigest(): Promise<string> {
  return ((await invoke(BRIDGE_CHANNELS.takeClipboardSnapshot, {})) as ClipboardSnapshot).digest;
}

/** Writes the late copy `copyId` names onto the clipboard as it is held. */
async function writeLateCopy(copyId: string): Promise<unknown> {
  return invoke(BRIDGE_CHANNELS.copyToClipboardUnlessChanged, {
    copyId,
    since: { digest: await heldDigest() },
  });
}

/** The pictures main has kept in its paste folder; none while the folder is not made yet. */
async function pastedPictures(userData: string): Promise<string[]> {
  return readdir(path.join(userData, PASTED_IMAGES_FOLDER_NAME)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
}

/** The cases whose accepted payload is built in the case: a token, a real file. */
async function intakeCases(subject: BoundarySubject): Promise<readonly IntakeCase[]> {
  const { connection, bridge, userData, windowActs } = subject;
  // Its snapshot is taken as it is sent, after the writes the cases before it made.
  const acceptedLateWrite = { copyId: "late", since: { digest: ANY_DIGEST } };
  const acceptedFormatting = { copyId: "formatted" };
  let formattingTextWrites = 0;
  const droppedFile = path.join(userData, "dropped.txt");
  await writeFile(droppedFile, "dropped");
  // A token main minted to attach the file, which no verb that opens a path takes.
  const attachToken = await invoke(BRIDGE_CHANNELS.getDroppedFileRef, droppedFile);
  const droppedTokens: unknown[] = [];
  // The drop's probe copy is sent once, on its first reading, so every later reading sees it held
  // until the accepted drop lets it go.
  let isDropProbeSent = false;
  const appearance = {
    choice: { theme: "graphite", scheme: "dark", textSize: 18, transcriptWidth: 44 },
    grounds: THEME_GROUNDS.meridian,
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
      refusal: REQUEST_UNSENDABLE_MESSAGE,
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
      refusal:
        /failed schema validation|could not be sent to the background service|"code": "invalid_type"/,
      accepted: { method: "presence.read", params: {} },
      send: (payload) => invoke(BRIDGE_CHANNELS.daemonCall, payload),
      acted: () => connection.requests.length,
    },
    {
      member: "native.showOpenDialog",
      refused: [{ purpose: "exportFile" }, { purpose: 7 }, "attachFiles", {}, null],
      refusal: "An open dialog is asked for one of its purposes",
      accepted: { purpose: "attachFiles" },
      send: (payload) => invoke(BRIDGE_CHANNELS.showOpenDialog, payload),
      acted: () => dialogOpens.length,
    },
    {
      member: "native.getDroppedFileRef",
      refused: [7, "dropped.txt", "", userData, path.join(userData, "missing.txt"), null],
      refusal:
        /Only a file dropped from this computer|A dropped folder cannot be|The operating system refused this request/,
      accepted: droppedFile,
      send: async (payload) => {
        droppedTokens.push(await invoke(BRIDGE_CHANNELS.getDroppedFileRef, payload));
      },
      acted: () => droppedTokens.length,
    },
    {
      member: "native.savePastedImage",
      refused: [new ArrayBuffer(0), new Uint8Array([137, 80]), [137, 80], "iVBORw0KGgo=", null],
      refusal: "A pasted picture arrives as its bytes",
      accepted: new Uint8Array([137, 80, 78, 71]).buffer,
      send: (payload) => invoke(BRIDGE_CHANNELS.savePastedImage, payload),
      acted: async () => await pastedPictures(userData),
    },
    {
      member: "native.openExternal",
      refused: ["file:///etc/passwd", "javascript:alert(1)", "sidekicks-renderer://app/", 7, null],
      refusal: /Refused to open an outside address|An outside address is a string/,
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
        { ref: "the-token", extra: true },
        "the-token",
        null,
      ],
      refusal: /not one this window was given|"code": "(invalid_type|too_small|unrecognized_keys)"/,
      accepted: { ref: "the-token" },
      send: async (payload) => invoke(BRIDGE_CHANNELS.openInEditor, await withToken(payload)),
      acted: () => electronMock.pathOpens.length,
    },
    {
      member: "native.copyToClipboard",
      refused: [
        { content: { text: 7 } },
        { content: { html: "<b>a</b>" } },
        { content: { text: "a", html: 7 } },
        { content: { text: "a", extra: true } },
        { content: { png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) } },
        { content: { text: "a", png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) } },
        { content: { text: "a" }, clipboard: "system" },
        { content: { text: "a" }, extra: true },
        { text: "a" },
        "a",
        null,
      ],
      refusal: SCHEMA_REFUSAL,
      accepted: { content: { text: "a", html: "<b>a</b>" } },
      send: (payload) => invoke(BRIDGE_CHANNELS.copyToClipboard, payload),
      acted: () => clipboardWrites.length,
    },
    {
      member: "native.takeClipboardSnapshot",
      refused: [{ clipboard: "system" }, { clipboard: 7 }, { extra: true }, "a", null],
      refusal: SCHEMA_REFUSAL,
      accepted: {},
      send: (payload) => invoke(BRIDGE_CHANNELS.takeClipboardSnapshot, payload),
      acted: () => clipboardReads.length,
    },
    {
      member: "native.sendClipboardPiece",
      refused: [
        { copyId: "piece-probe", flavor: "text", index: 0 },
        { copyId: "piece-probe", flavor: "rtf", index: 0, piece: "a" },
        { copyId: "piece-probe", flavor: "text", index: -1, piece: "a" },
        { copyId: "piece-probe", flavor: "text", index: 0.5, piece: "a" },
        { copyId: 7, flavor: "text", index: 0, piece: "a" },
        { copyId: "piece-probe", flavor: "text", index: 0, piece: "a", extra: true },
        { copyId: "piece-probe", flavor: "text", index: 0, piece: new Uint8Array([97]) },
        { copyId: "piece-probe", flavor: "png", index: 0, piece: "iVBORw0KGgo=" },
        "a",
        null,
      ],
      refusal: SCHEMA_REFUSAL,
      accepted: { copyId: "piece-probe", flavor: "text", index: 0, piece: "a" },
      send: (payload) => invoke(BRIDGE_CHANNELS.sendClipboardPiece, payload),
      // Whether a late copy of the probe's pieces is written, or not for want of them.
      acted: () => writeLateCopy("piece-probe"),
    },
    {
      member: "native.dropClipboardPieces",
      refused: [{ copyId: 7 }, { copyId: "drop-probe", extra: true }, "drop-probe", null],
      refusal: SCHEMA_REFUSAL,
      accepted: { copyId: "drop-probe" },
      send: (payload) => invoke(BRIDGE_CHANNELS.dropClipboardPieces, payload),
      acted: async () => {
        if (!isDropProbeSent) {
          isDropProbeSent = true;
          await sendTextPiece("drop-probe");
        }
        return await writeLateCopy("drop-probe");
      },
    },
    {
      member: "native.copyToClipboardUnlessChanged",
      refused: [
        { copyId: "late" },
        { copyId: "late", since: { digest: 7 } },
        { copyId: "late", since: { clipboard: "system", digest: ANY_DIGEST } },
        { copyId: 7, since: { digest: ANY_DIGEST } },
        { content: { copyId: "late" }, since: { digest: ANY_DIGEST } },
        { png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), since: { digest: ANY_DIGEST } },
        { copyId: "late", since: { digest: ANY_DIGEST }, extra: true },
        "a",
        null,
      ],
      refusal: SCHEMA_REFUSAL,
      accepted: acceptedLateWrite,
      send: async (payload) => {
        await sendTextPiece("late");
        return await invoke(
          BRIDGE_CHANNELS.copyToClipboardUnlessChanged,
          payload === acceptedLateWrite
            ? { copyId: "late", since: { digest: await heldDigest() } }
            : payload,
        );
      },
      acted: () => clipboardWrites.length,
    },
    {
      member: "native.addClipboardFormatting",
      refused: [
        { text: "a", html: "<b>a</b>" },
        { copyId: 7 },
        { copyId: "formatted", extra: true },
        "formatted",
        null,
      ],
      refusal: SCHEMA_REFUSAL,
      accepted: acceptedFormatting,
      send: async (payload) => {
        await sendTextPiece("formatted");
        // Formatting goes beside its copy's text once that text landed, which writes once itself.
        if (payload === acceptedFormatting) {
          expect(await writeLateCopy("formatted")).toBe(true);
          formattingTextWrites += 1;
        }
        await invoke(BRIDGE_CHANNELS.sendClipboardPiece, {
          copyId: "formatted",
          flavor: "html",
          index: 0,
          piece: "<b>a</b>",
        });
        return await invoke(BRIDGE_CHANNELS.addClipboardFormatting, payload);
      },
      acted: () => clipboardWrites.length - formattingTextWrites,
    },
    {
      member: "native.revealInFileExplorer",
      refused: [MEMORY_FILE, attachToken, randomUUID(), 7, null],
      refusal: "That file reference is not one this window was given",
      accepted: "the-token",
      send: async (payload) =>
        invoke(BRIDGE_CHANNELS.revealInFileExplorer, await withToken(payload)),
      acted: () => revealedPaths.length,
    },
    {
      member: "keyboardMap.write",
      refused: [{ "frame.goToSessions": 7 }, { "": "$mod+b" }, "$mod+b", [], null],
      refusal: SCHEMA_REFUSAL,
      accepted: { "frame.goToSessions": "$mod+b" },
      send: (payload) => invoke(BRIDGE_CHANNELS.writeKeyboardMap, payload),
      acted: async () => ((await bridge.keyboardMap.read()) as { map: object }).map,
    },
    {
      member: "window.setAppearance",
      refused: [
        { ...appearance, choice: { ...appearance.choice, theme: "neon" } },
        { ...appearance, choice: { ...appearance.choice, textSize: 17 } },
        { ...appearance, choice: { ...appearance.choice, transcriptWidth: 35 } },
        { ...appearance, grounds: { light: "white", dark: THEME_GROUNDS.meridian.dark } },
        { ...appearance, extra: true },
        appearance.choice,
        null,
      ],
      refusal: SCHEMA_REFUSAL,
      accepted: appearance,
      send: (payload) => invoke(BRIDGE_CHANNELS.setAppearance, payload),
      acted: () => windowActs.appearanceChoices.length,
    },
    {
      member: "window.setMinimumSize",
      refused: [
        { windowId: "w-1", size: { width: 0, height: 400 } },
        { windowId: "w-1", size: { width: -1, height: 400 } },
        { windowId: "w-1", size: { width: Number.NaN, height: 400 } },
        { windowId: "w-1", size: { width: "600", height: 400 } },
        { windowId: 7, size: { width: 600, height: 400 } },
        { windowId: "w-1", size: { width: 600, height: 400 }, extra: true },
        null,
      ],
      refusal: SCHEMA_REFUSAL,
      accepted: { windowId: "w-1", size: { width: 600, height: 400 } },
      send: (payload) => invoke(BRIDGE_CHANNELS.setMinimumSize, payload),
      acted: () => windowActs.minimumSizes.length,
    },
    {
      member: "window.bringForward",
      refused: [7, { windowId: "w-1" }, ["w-1"], null],
      refusal: SCHEMA_REFUSAL,
      accepted: "w-1",
      send: (payload) => invoke(BRIDGE_CHANNELS.bringWindowForward, payload),
      acted: () => windowActs.windowsBroughtForward,
    },
    {
      member: "window.paste",
      refused: [7, { windowId: "w-1" }, ["w-1"], null],
      refusal: SCHEMA_REFUSAL,
      accepted: "w-1",
      send: (payload) => invoke(BRIDGE_CHANNELS.pasteInWindow, payload),
      acted: () => windowActs.pastes,
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
      refusal: SCHEMA_REFUSAL,
      accepted: { paneWidths: { sessions: 300 } },
      send: (payload) => invoke(BRIDGE_CHANNELS.setDefaultSizes, payload),
      acted: () => windowActs.defaultSizes.length,
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
    const subject = await openBoundary();
    const { connection } = subject;
    for (const intake of await intakeCases(subject)) {
      const before = await intake.acted();
      const requestsBefore = connection.requests.length;
      for (const payload of intake.refused) {
        const named = `${intake.member} ${JSON.stringify(payload)}`;
        if (intake.contract !== undefined) {
          expect(intake.contract.safeParse(payload).success, named).toBe(false);
        }
        expect(await refusalOf(intake.send(payload)), named).toMatch(intake.refusal);
        expect(await intake.acted(), named).toStrictEqual(before);
      }
      // Minting a token reads the memory file's reply; nothing a refused payload carried is sent.
      const sentByRefused = connection.requests
        .slice(requestsBefore)
        .filter((request) => request.method !== "session.memoryRead");
      expect(sentByRefused, intake.member).toEqual([]);

      // Negative control: a payload inside the contract is taken and acted on.
      expect(await refusalOf(intake.send(intake.accepted)), intake.member).toBeUndefined();
      await setImmediate();
      expect(await intake.acted(), intake.member).not.toStrictEqual(before);
    }
  });

  it("refuses a status topic opened with a request, and a subscription with no new id", async () => {
    const { connection, bridge } = await openBoundary();
    expect(() =>
      bridge.daemon.subscribe(
        "daemon.status",
        { sessionId: randomUUID() } as never,
        () => undefined,
      ),
    ).toThrow(REQUEST_UNSENDABLE_MESSAGE);

    expect(openSubscription({ subscriptionId: "1", event: "daemon.status", params: {} })).toEqual({
      outcome: "unsendable",
    });
    expect(connection.requests).toEqual([]);
  });

  it("opens only the daemon streams the app opens, sending nothing for any other method", async () => {
    const { connection } = await openBoundary();
    for (const [event, params] of [
      ["daemon.stop", {}],
      ["session.attachmentAdd", { sessionId: SESSION_ID, items: [{ path: "/etc/passwd" }] }],
    ] as const) {
      expect(openSubscription({ subscriptionId: randomUUID(), event, params }), event).toEqual({
        outcome: "unsendable",
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
      await expect(invoke(BRIDGE_CHANNELS.closeDaemonSubscription, refusedId)).rejects.toThrow(
        SCHEMA_REFUSAL,
      );
    }
    await invoke(BRIDGE_CHANNELS.closeDaemonSubscription, subscriptionId);
    await setImmediate();
    expect(connection.requests.map((request) => request.method)).toEqual([
      "session.subscribe",
      "$/subscription/cancel",
    ]);
  });
});
