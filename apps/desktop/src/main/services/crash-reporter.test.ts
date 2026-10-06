// The crash reporter reads `Keep crash reports` straight from the machine's settings file, before
// the background service answers, and starts Crashpad with nothing uploaded while it is on.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MACHINE_SETTINGS_FILE_PATH_SEGMENTS } from "@ai-sidekicks/contracts/machine-settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startCrashReporter, type CrashReporterDependencies } from "./crash-reporter.js";

let homeDirectory: string;

beforeEach(async () => {
  homeDirectory = await mkdtemp(path.join(tmpdir(), "sidekicks-crash-reporter-test-"));
});

afterEach(async () => {
  await rm(homeDirectory, { recursive: true, force: true });
});

function dependenciesOverHome(): CrashReporterDependencies & {
  readonly start: ReturnType<typeof vi.fn>;
  readonly reported: string[];
} {
  const start = vi.fn();
  const reported: string[] = [];
  return {
    start,
    reported,
    crashReporter: { start },
    homeDirectory,
    readTextFile: (filePath) => readFileSync(filePath, "utf8"),
    reportUnreadableSettings: (message) => {
      reported.push(message);
    },
  };
}

async function writeSettingsFile(text: string): Promise<void> {
  const settingsPath = path.join(homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, text, "utf8");
}

describe("the crash reporter", () => {
  it("keeps reports on this machine only when no settings file exists yet", () => {
    const dependencies = dependenciesOverHome();

    startCrashReporter(dependencies);

    expect(dependencies.start).toHaveBeenCalledExactlyOnceWith({ uploadToServer: false });
    expect(dependencies.reported).toStrictEqual([]);
  });

  it("starts nothing while `Keep crash reports` is off", async () => {
    await writeSettingsFile(JSON.stringify({ keepCrashReports: false }));
    const dependencies = dependenciesOverHome();

    startCrashReporter(dependencies);

    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it("reads a broken file as the defaults, which keep reports, and reports it", async () => {
    await writeSettingsFile("{ not json");
    const brokenDependencies = dependenciesOverHome();
    startCrashReporter(brokenDependencies);
    expect(brokenDependencies.start).toHaveBeenCalledExactlyOnceWith({ uploadToServer: false });
    expect(brokenDependencies.reported).toEqual([expect.stringContaining("is not JSON")]);

    await writeSettingsFile(JSON.stringify({ keepCrashReports: "no" }));
    const malformedDependencies = dependenciesOverHome();
    startCrashReporter(malformedDependencies);
    expect(malformedDependencies.start).toHaveBeenCalledExactlyOnceWith({ uploadToServer: false });
    expect(malformedDependencies.reported).toEqual([
      expect.stringContaining("does not match its schema"),
    ]);
  });

  it("reports a settings file that exists and cannot be read, and keeps reports", () => {
    const dependencies = dependenciesOverHome();

    startCrashReporter({
      ...dependencies,
      readTextFile: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    expect(dependencies.start).toHaveBeenCalledExactlyOnceWith({ uploadToServer: false });
    expect(dependencies.reported).toEqual([expect.stringContaining("permission denied")]);
  });
});
