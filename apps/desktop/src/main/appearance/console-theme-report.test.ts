// The console theme's terminal colors reach the background service once a link is up, again at
// every change of theme or scheme and on every new link, never twice for the same state, and a
// failed report is logged and sent again at the next change.

import type { JsonRpcClient } from "@ai-sidekicks/client-sdk";
import {
  PtyReportTerminalAppearanceRequestSchema,
  type PtyReportTerminalAppearanceRequest,
} from "@ai-sidekicks/contracts/pty";
import { describe, expect, it } from "vitest";

import { DEFAULT_APPEARANCE_RECORD, type AppearanceRecord } from "#shared/appearance.js";
import type { ColorScheme } from "#shared/color-scheme.js";

import type { MainDiagnosticEntry } from "../services/diagnostic-log.js";
import { DaemonLink, unlinkedState } from "../services/daemon/link/status.js";
import { ConsoleThemeReport } from "./console-theme-report.js";

/** A daemon client that records each report and answers with `answer`. */
function createClient(answer: () => Promise<null> = () => Promise.resolve(null)): {
  readonly client: JsonRpcClient;
  readonly reports: PtyReportTerminalAppearanceRequest[];
} {
  const reports: PtyReportTerminalAppearanceRequest[] = [];
  const client = {
    call: (method: string, params: unknown) => {
      expect(method).toBe("pty.reportTerminalAppearance");
      reports.push(PtyReportTerminalAppearanceRequestSchema.parse(params));
      return answer();
    },
  } as unknown as JsonRpcClient;
  return { client, reports };
}

/** A kept appearance whose record and scheme the test sets, telling its listeners. */
function createAppearance(): {
  record: AppearanceRecord;
  resolvedScheme: ColorScheme;
  subscribe(listener: () => void): () => void;
  change(next: Partial<{ record: AppearanceRecord; resolvedScheme: ColorScheme }>): void;
} {
  const listeners = new Set<() => void>();
  return {
    record: DEFAULT_APPEARANCE_RECORD,
    resolvedScheme: "light",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    change(next) {
      Object.assign(this, next);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const CONNECTED = unlinkedState({ kind: "connected" });

describe("ConsoleThemeReport", () => {
  it("reports on connect, on each theme or scheme change and on each new link, once per state", () => {
    const link = new DaemonLink();
    const appearance = createAppearance();
    const logged: MainDiagnosticEntry[] = [];
    new ConsoleThemeReport({
      link,
      appearance,
      log: { write: (entry) => logged.push(entry) },
    }).start();

    const first = createClient();
    link.attach(first.client, unlinkedState({ kind: "version_incompatible" }));
    expect(first.reports).toEqual([]);

    link.attach(first.client, CONNECTED);
    link.report(CONNECTED);
    appearance.change({ record: { ...DEFAULT_APPEARANCE_RECORD, textSize: 18 } });
    expect(first.reports).toHaveLength(1);
    const [light] = first.reports;
    if (light?.source !== "console_theme") {
      throw new Error("expected a console theme report");
    }
    // Black and white sit at the ends of the reading scale: bright white is the text, and white and
    // bright black share the muted step.
    expect(light.colors.palette[15]).toBe(light.colors.foreground);
    expect(light.colors.palette[7]).toBe(light.colors.palette[8]);
    expect(light.colors.cursor).toBe(light.colors.foreground);

    appearance.change({ resolvedScheme: "dark" });
    appearance.change({ record: { ...DEFAULT_APPEARANCE_RECORD, theme: "graphite" } });
    expect(first.reports).toHaveLength(3);
    expect(first.reports[1]).not.toEqual(light);
    expect(first.reports[2]).not.toEqual(first.reports[1]);

    link.detach(unlinkedState({ kind: "stopped" }));
    const second = createClient();
    link.attach(second.client, CONNECTED);
    expect(second.reports).toEqual([first.reports[2]]);
    expect(logged).toEqual([]);
  });

  it("logs a report the service refused and sends again at the next change", async () => {
    const link = new DaemonLink();
    const appearance = createAppearance();
    const logged: MainDiagnosticEntry[] = [];
    new ConsoleThemeReport({
      link,
      appearance,
      log: { write: (entry) => logged.push(entry) },
    }).start();

    let isRefusing = true;
    const { client, reports } = createClient(() =>
      isRefusing ? Promise.reject(new Error("refused")) : Promise.resolve(null),
    );
    link.attach(client, CONNECTED);
    await expect.poll(() => logged.length).toBe(1);
    expect(logged[0]?.message).toContain("refused");

    isRefusing = false;
    link.report(CONNECTED);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
  });
});
