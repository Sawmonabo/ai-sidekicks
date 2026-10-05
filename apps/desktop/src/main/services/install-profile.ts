// Which profile folder this install keeps its state in. Electron keys the single-instance lock, and
// every file main and the renderer keep, to the user-data folder, so two installs sharing one would
// share a lock and a profile. A shipped build keeps the platform's own folder for the app. A
// development build, which is unpackaged, takes a folder of its own named for its checkout, so it
// never takes the shipped app's lock or reads its state, and two checkouts never take each other's.
// A launch handed `--user-data-dir`, as every test tier's is, keeps the folder it names.

import { createHash } from "node:crypto";
import path from "node:path";

import type { App } from "electron";

/** The part of Electron's `app` the profile is chosen through. */
export interface InstallProfileApp extends Pick<
  App,
  "isPackaged" | "getAppPath" | "getName" | "getPath" | "setPath"
> {
  readonly commandLine: Pick<App["commandLine"], "hasSwitch">;
}

/**
 * Points a development build's user-data folder at one keyed to its checkout. Call before
 * `app.requestSingleInstanceLock()` and before anything reads the folder.
 */
export function keyProfileToInstall(app: InstallProfileApp): void {
  if (app.isPackaged || app.commandLine.hasSwitch("user-data-dir")) {
    return;
  }
  const checkout = createHash("sha256").update(app.getAppPath()).digest("hex").slice(0, 12);
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), `${app.getName()} development ${checkout}`),
  );
}
