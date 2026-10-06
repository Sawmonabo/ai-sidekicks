// Every bridge member's channels are answered, and refuse a frame that is not one of the app's own
// documents. A failure reaches the page with no path in it, and main's log keeps it whole.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  BRIDGE_CHANNELS,
  BRIDGE_MEMBER_CHANNELS,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
} from "#shared/bridge-channels.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import { INDEX_URL } from "#test/helpers/electron/mock/readers.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

let userData: string;
let log: { readonly write: Mock<MainDiagnosticLog["write"]> };

beforeEach(async () => {
  electronMock.reset();
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-bridge-handlers-test-"));
  vi.resetModules();
  const { installBridgeHandlers } = await import("./install-handlers.js");
  const { DaemonForwarding } = await import("./daemon.js");
  const { DaemonLink } = await import("../services/daemon/link/status.js");
  const { FilePathRefs } = await import("./file-path/refs.js");
  const { PASTED_IMAGES_FOLDER_NAME, PastedImages } = await import("./native/file-intake.js");
  const link = new DaemonLink();
  log = { write: vi.fn<MainDiagnosticLog["write"]>() };
  const filePathRefs = new FilePathRefs();
  const pastedImages = new PastedImages({
    folder: path.join(userData, PASTED_IMAGES_FOLDER_NAME),
    filePathRefs,
    log,
  });
  installBridgeHandlers({
    userData,
    daemonForwarding: new DaemonForwarding({
      link,
      supervisor: { endService: vi.fn() },
      log,
      filePathRefs,
      pastedImages,
    }),
    filePathRefs,
    pastedImages,
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
        endSafeStart: vi.fn(),
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
  it("answers every member's channels, refusing an outside origin and a frame with no document", async () => {
    const invokedChannels = new Set(
      Object.values(BRIDGE_MEMBER_CHANNELS)
        .flat()
        .filter((channel) => channel !== OPEN_DAEMON_SUBSCRIPTION_CHANNEL),
    );
    for (const channel of invokedChannels) {
      await expect(invokeFrom("https://example.com/", channel)).rejects.toThrow(
        `${channel} answers only the app's own renderer documents.`,
      );
      await expect(invokeFrom(undefined, channel)).rejects.toThrow(
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
    await expect(invokeFrom(INDEX_URL, BRIDGE_CHANNELS.readKeyboardMap)).resolves.toStrictEqual({
      map: {},
    });
  });

  it("answers a system failure by its code, with no path in it, and logs it whole", async () => {
    // The profile folder is a file, so writing the map under it fails in the operating system.
    await rm(userData, { recursive: true, force: true });
    await writeFile(userData, "");

    const writing = invokeFrom(INDEX_URL, BRIDGE_CHANNELS.writeKeyboardMap, {}) as Promise<unknown>;

    await expect(writing).rejects.toThrow(
      new RegExp(`^${BRIDGE_CHANNELS.writeKeyboardMap} failed \\(E[A-Z]+\\)\\.$`),
    );
    await writing.catch((failure: unknown) => {
      expect(String(failure)).not.toContain(userData);
    });
    expect(JSON.stringify(log.write.mock.calls)).toContain(userData);
  });

  it("answers a failed opening on the synchronous channel rather than leaving the page waiting", () => {
    const openSubscription = electronMock.ipcListeners.get(OPEN_DAEMON_SUBSCRIPTION_CHANNEL);
    if (openSubscription === undefined) {
      throw new Error(`nothing answers ${OPEN_DAEMON_SUBSCRIPTION_CHANNEL}`);
    }
    // A sender that cannot be sent to throws as the status topic delivers its first state.
    const DISPOSED_FRAME = "Render frame was disposed before WebFrameMain could be accessed";
    const event = {
      senderFrame: { url: INDEX_URL },
      sender: {
        id: 1,
        on: () => undefined,
        once: () => undefined,
        send: () => {
          throw new Error(DISPOSED_FRAME);
        },
      },
      returnValue: undefined as unknown,
    };
    const request = {
      subscriptionId: "6c1f3b1e-8a39-4f43-9d1e-2b6f0a4c5d7e",
      event: "daemon.status",
      params: {},
    };
    openSubscription(event as never, request as never);

    expect(event.returnValue).toStrictEqual({ outcome: "failed", message: DISPOSED_FRAME });
    expect(log.write).toHaveBeenCalledTimes(1);
  });
});
