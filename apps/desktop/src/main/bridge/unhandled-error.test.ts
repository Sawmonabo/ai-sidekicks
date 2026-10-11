// A window's unhandled error goes from the page's bridge through main to the service's diagnostic
// log bounded and stripped: every quoted run out of the message, the stack cut to its frames and
// its bound, the script's address without its query; a report that is not one is refused whole
// and nothing is sent.

import { APP_ERROR_TEXT_BOUNDS } from "@ai-sidekicks/contracts/daemon/app-error";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import { bridgeOver, scriptedConnection } from "./daemon.test-support.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const FRAME = "    at renderRow (app://renderer/assets/index-3f2a.js:120:17)";

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
});

describe("a window's unhandled error through main", () => {
  it("reaches the service bounded, its quoted value and its stack's message taken out", async () => {
    const connection = scriptedConnection(() => ({ result: {} }));
    const bridge = await bridgeOver(connection);
    const frameCount = Math.ceil((2 * APP_ERROR_TEXT_BOUNDS.stack) / FRAME.length);

    await bridge.app.reportUnhandledError({
      kind: "uncaught-error",
      role: "console-window",
      name: "SyntaxError",
      message: `Unexpected token 'p', "password=hunter2" is not valid JSON`,
      stack: [`SyntaxError: "password=hunter2"`, ...Array<string>(frameCount).fill(FRAME)].join(
        "\n",
      ),
      source: {
        address: "app://renderer/assets/index-3f2a.js?token=abc#frame",
        line: 120,
        column: 17,
      },
    });
    await vi.waitFor(() => {
      expect(connection.requests).toHaveLength(1);
    });

    const [{ method, params }] = connection.requests as [{ method: string; params: never }];
    expect(method).toBe("daemon.appError.record");
    const record = params as {
      readonly message: string;
      readonly stack: string;
      readonly source: { readonly address: string };
    };
    expect(record).toMatchObject({
      kind: "uncaught-error",
      role: "console-window",
      name: "SyntaxError",
      message: 'Unexpected token "…" is not valid JSON',
      source: { address: "app://renderer/assets/index-3f2a.js", line: 120, column: 17 },
    });
    expect(record.stack).toHaveLength(APP_ERROR_TEXT_BOUNDS.stack);
    expect(record.stack.startsWith(FRAME)).toBe(true);
    expect(JSON.stringify(params)).not.toContain("hunter2");
  });

  it("refuses a report that is not one and sends nothing", async () => {
    const connection = scriptedConnection(() => ({ result: {} }));
    const bridge = await bridgeOver(connection);
    const report = {
      kind: "uncaught-error",
      name: null,
      message: "x is not a function",
      stack: null,
      source: null,
    } as const;

    await expect(
      bridge.app.reportUnhandledError({ ...report, role: "main" as never }),
    ).rejects.toThrow();
    await expect(
      bridge.app.reportUnhandledError({ ...report, role: "pane-window", extra: 1 } as never),
    ).rejects.toThrow();

    expect(connection.requests).toStrictEqual([]);
  });
});
