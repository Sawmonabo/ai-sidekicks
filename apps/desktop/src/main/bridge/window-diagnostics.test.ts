// What a window records about itself goes from the page's bridge through main to the service's
// diagnostic log redacted and bounded: every quoted run out of a message or a captured line, the
// stack cut to its frames and its bound, the script's address without its query; a batch that is
// not one is refused whole and nothing is sent.

import { APP_DIAGNOSTIC_TEXT_BOUNDS } from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WINDOW_DIAGNOSTIC_BATCH_BOUND } from "#shared/app-diagnostic/report.js";
import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import { bridgeOver, scriptedConnection } from "./daemon.test-support.js";

const electronMock = createElectronMock();

vi.mock("electron", () => electronMock.moduleExports);

const FRAME = "    at renderRow (app://renderer/assets/index-3f2a.js:120:17)";

const CAPTURED_AT = "2026-10-11T15:59:58.000Z";

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
});

describe("a window's diagnostics through main", () => {
  it("reach the service bounded, quoted values and the stack's message taken out", async () => {
    const connection = scriptedConnection(() => ({ result: {} }));
    const bridge = await bridgeOver(connection);
    const frameCount = Math.ceil((2 * APP_DIAGNOSTIC_TEXT_BOUNDS.stack) / FRAME.length);

    await bridge.app.reportWindowDiagnostics([
      {
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
      },
      {
        kind: "captured",
        record: {
          at: CAPTURED_AT,
          severity: "warning",
          source: "services/daemon/reply",
          kind: "reply-unreadable",
          detail: `presence.read answered "hunter2" where a device was due`,
        },
      },
    ]);
    await vi.waitFor(() => {
      expect(connection.requests).toHaveLength(2);
    });

    const [thrown, captured] = connection.requests as [
      { method: string; params: { readonly stack: string } },
      { method: string; params: unknown },
    ];
    expect(thrown.method).toBe("daemon.appDiagnostic.record");
    expect(thrown.params).toMatchObject({
      kind: "uncaught-error",
      role: "console-window",
      name: "SyntaxError",
      message: 'Unexpected token "…" is not valid JSON',
      source: { address: "app://renderer/assets/index-3f2a.js", line: 120, column: 17 },
    });
    expect(thrown.params.stack).toHaveLength(APP_DIAGNOSTIC_TEXT_BOUNDS.stack);
    expect(thrown.params.stack.startsWith(FRAME)).toBe(true);
    expect(captured).toStrictEqual({
      method: "daemon.appDiagnostic.record",
      params: {
        kind: "captured",
        at: CAPTURED_AT,
        severity: "warning",
        source: "services/daemon/reply",
        capturedKind: "reply-unreadable",
        detail: 'presence.read answered "…" where a device was due',
      },
    });
    expect(JSON.stringify(connection.requests)).not.toContain("hunter2");
  });

  it("refuses a batch that is not one and sends nothing", async () => {
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
      bridge.app.reportWindowDiagnostics([{ ...report, role: "main" as never }]),
    ).rejects.toThrow();
    await expect(
      bridge.app.reportWindowDiagnostics([{ ...report, role: "pane-window", extra: 1 } as never]),
    ).rejects.toThrow();
    await expect(
      bridge.app.reportWindowDiagnostics(
        Array.from({ length: WINDOW_DIAGNOSTIC_BATCH_BOUND + 1 }, () => ({
          ...report,
          role: "pane-window" as const,
        })),
      ),
    ).rejects.toThrow();

    expect(connection.requests).toStrictEqual([]);
  });
});
