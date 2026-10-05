// The crash reporter: Crashpad writes each crash of main and every renderer to this machine only,
// and nothing is uploaded anywhere. It starts before the background service has answered, so the
// one value it needs, `Keep crash reports`, is read straight from the machine's settings file,
// which main may read itself only before that first answer. The service turns each dump into a
// stripped report on the machine; this module scrubs nothing, because a dump is not a report.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MACHINE_SETTINGS_DEFAULTS,
  MACHINE_SETTINGS_FILE_PATH_SEGMENTS,
  parseMachineSettingsFile,
} from "@ai-sidekicks/contracts/machine-settings";
import type { CrashReporter } from "electron";

import type { MainDiagnosticLog } from "./diagnostic-log.js";
import { isMissingPath } from "./missing-path.js";

/** What the crash reporter reads the settings file through and starts Crashpad with. */
export interface CrashReporterHost {
  readonly crashReporter: Pick<CrashReporter, "start">;
  /** The person's home folder, under which the settings file lives. */
  readonly homeDirectory: string;
  /** Reads a file as text; throws as `fs.readFileSync` does. */
  readonly readTextFile: (filePath: string) => string;
  /** Where a settings file main could not read is reported. */
  readonly reportUnreadableSettings: (message: string) => void;
}

/**
 * Starts Crashpad, keeping reports on this machine only, unless `Keep crash reports` is off. A
 * missing or broken settings file reads as the defaults, as the service reads it; a file that
 * exists and cannot be read is reported and read as the defaults too.
 */
export function startCrashReporter(host: CrashReporterHost): void {
  if (!readKeepCrashReports(host)) {
    return;
  }
  host.crashReporter.start({ uploadToServer: false });
}

/**
 * The crash reporter's host on this process: Electron's reporter, the real file system, and main's
 * log for a settings file it could not read.
 */
export function processCrashReporterHost(
  crashReporter: Pick<CrashReporter, "start">,
  homeDirectory: string,
  log: Pick<MainDiagnosticLog, "write">,
): CrashReporterHost {
  return {
    crashReporter,
    homeDirectory,
    readTextFile: (filePath) => readFileSync(filePath, "utf8"),
    reportUnreadableSettings: (message) => {
      log.write({
        at: new Date().toISOString(),
        level: "error",
        source: "main/crash-reporter",
        message,
      });
    },
  };
}

function readKeepCrashReports(host: CrashReporterHost): boolean {
  const settingsPath = path.join(host.homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS);
  let fileText: string;
  try {
    fileText = host.readTextFile(settingsPath);
  } catch (readFailure) {
    if (!isMissingPath(readFailure)) {
      host.reportUnreadableSettings(
        `The machine's settings file could not be read, so crash reports are kept: ` +
          `${readFailure instanceof Error ? readFailure.message : String(readFailure)}`,
      );
    }
    return MACHINE_SETTINGS_DEFAULTS.keepCrashReports;
  }
  let fileJson: unknown;
  try {
    fileJson = JSON.parse(fileText);
  } catch {
    // A broken file reads as the defaults; the service repairs it when it starts.
    return MACHINE_SETTINGS_DEFAULTS.keepCrashReports;
  }
  const parsed = parseMachineSettingsFile(fileJson);
  return parsed.success ? parsed.data.keepCrashReports : MACHINE_SETTINGS_DEFAULTS.keepCrashReports;
}
