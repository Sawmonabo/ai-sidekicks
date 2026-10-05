// Every bridge member's channels are answered, and refuse a frame that is not one of the app's own
// documents.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_CHANNELS,
  BRIDGE_MEMBER_CHANNELS,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
} from "#shared/bridge-channels.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { createElectronMock } from "#test/helpers/electron/mock/electron-mock.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

let userData: string;

beforeEach(async () => {
  electronMock.reset();
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-bridge-handlers-test-"));
  vi.resetModules();
  const { installBridgeHandlers } = await import("./install-bridge-handlers.js");
  const { DaemonForwarding } = await import("./daemon.js");
  const { DaemonLink } = await import("../services/daemon/daemon-link.js");
  const { FilePathRefs } = await import("./file-path/file-path-refs.js");
  const link = new DaemonLink();
  const log = { write: vi.fn() };
  const filePathRefs = new FilePathRefs();
  installBridgeHandlers({
    userData,
    daemonForwarding: new DaemonForwarding({
      link,
      supervisor: { endService: vi.fn() },
      log,
      now: () => new Date(),
      filePathRefs,
    }),
    filePathRefs,
    supervisor: { requestStart: vi.fn() },
    daemonLink: link,
    log,
    windowContext: {
      appearance: { choose: vi.fn(), record: DEFAULT_APPEARANCE_RECORD },
      openWindows: {
        windowWithId: vi.fn(),
        isConsoleDocument: vi.fn(),
        windowUsedLast: vi.fn(),
        setDefaultSizes: vi.fn(),
      },
    },
  });
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

/** Call a registered channel as a frame at `frameUrl` would. */
function invokeFrom(frameUrl: string | undefined, channel: string, request?: unknown): unknown {
  const handler = electronMock.ipcHandlers.get(channel) as
    | ((event: unknown, request: unknown) => unknown)
    | undefined;
  if (handler === undefined) {
    throw new Error(`nothing answers ${channel}`);
  }
  return handler(
    { senderFrame: frameUrl === undefined ? null : { url: frameUrl }, sender: {} },
    request,
  );
}

describe("the bridge's channels", () => {
  it("answers every member's channels, refusing an outside origin and a frame with no document", () => {
    const invokedChannels = new Set(
      Object.values(BRIDGE_MEMBER_CHANNELS)
        .flat()
        .filter((channel) => channel !== OPEN_DAEMON_SUBSCRIPTION_CHANNEL),
    );
    for (const channel of invokedChannels) {
      expect(() => invokeFrom("https://example.com/", channel)).toThrow(
        `${channel} answers only the app's own renderer documents.`,
      );
      expect(() => invokeFrom(undefined, channel)).toThrow(
        `${channel} answers only the app's own renderer documents.`,
      );
    }
    // The synchronous channel answers a refusal instead of throwing, so the page never waits.
    const channel = OPEN_DAEMON_SUBSCRIPTION_CHANNEL;
    const openSubscription = electronMock.ipcListeners.get(channel);
    if (openSubscription === undefined) {
      throw new Error(`nothing answers ${channel}`);
    }
    for (const frameUrl of ["https://example.com/", undefined]) {
      const event = {
        senderFrame: frameUrl === undefined ? null : { url: frameUrl },
        sender: {},
        returnValue: undefined,
      };
      openSubscription(event as never);
      expect(event.returnValue).toStrictEqual({
        outcome: "failed",
        message: `${channel} answers only the app's own renderer documents.`,
      });
    }
  });

  it("negative control: answers the app's own document", async () => {
    await expect(
      invokeFrom("sidekicks-renderer://app/index.html", BRIDGE_CHANNELS.readKeyboardMap),
    ).resolves.toStrictEqual({ map: {} });
  });

  it("refuses a map that is not one before writing it", async () => {
    expect(() =>
      invokeFrom("sidekicks-renderer://app/index.html", BRIDGE_CHANNELS.writeKeyboardMap, {
        "frame.goToSessions": 7,
      }),
    ).toThrow();
    await expect(
      invokeFrom("sidekicks-renderer://app/index.html", BRIDGE_CHANNELS.readKeyboardMap),
    ).resolves.toStrictEqual({ map: {} });
  });
});
