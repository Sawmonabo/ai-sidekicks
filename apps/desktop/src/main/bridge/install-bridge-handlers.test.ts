// Every channel main answers for the bridge answers only a console document: a frame on
// any other origin is refused before its request is read.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CHANNELS } from "@shared/bridge-channels.js";
import { createElectronMock } from "@test/helpers/electron-mock.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

let userData: string;

beforeEach(async () => {
  electronMock.reset();
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-bridge-handlers-test-"));
  vi.resetModules();
  const { installBridgeHandlers } = await import("./install-bridge-handlers.js");
  installBridgeHandlers({ userData });
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
  it("refuses a frame on an outside origin, and one with no document, on every channel", () => {
    for (const channel of Object.values(BRIDGE_CHANNELS)) {
      expect(() => invokeFrom("https://example.com/", channel)).toThrow(
        `${channel} answers only a console document.`,
      );
      expect(() => invokeFrom(undefined, channel)).toThrow(
        `${channel} answers only a console document.`,
      );
    }
  });

  it("negative control: answers the console's own document", async () => {
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
