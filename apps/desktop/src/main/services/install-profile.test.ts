// The profile, and with it the single-instance lock, is keyed to the install: a development
// build never shares the shipped app's folder, two checkouts never share one, and a launch that
// names its own folder keeps it. An unpackaged build's logs live in its profile.

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  keyProfileToInstall,
  PROFILE_LOGS_FOLDER_NAME,
  type InstallProfileApp,
} from "./install-profile.js";

/** An `app` for one install, recording where the user-data folder is pointed. */
function installApp(options: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly userDataSwitch?: boolean;
}): InstallProfileApp & {
  readonly setPath: ReturnType<typeof vi.fn>;
  readonly setAppLogsPath: ReturnType<typeof vi.fn>;
} {
  const paths = new Map<string, string>();
  return {
    isPackaged: options.isPackaged,
    getAppPath: () => options.appPath,
    getName: () => "AI Sidekicks",
    getPath: (name: string) => paths.get(name) ?? `/appData-root/${name}`,
    setPath: vi.fn((name: string, value: string) => {
      paths.set(name, value);
    }),
    setAppLogsPath: vi.fn(),
    commandLine: {
      hasSwitch: (name: string) => name === "user-data-dir" && options.userDataSwitch === true,
    },
  } as unknown as InstallProfileApp & {
    readonly setPath: ReturnType<typeof vi.fn>;
    readonly setAppLogsPath: ReturnType<typeof vi.fn>;
  };
}

/** The logs folder `app` was pointed at, or `undefined` when it kept the platform's. */
function chosenLogs(app: {
  readonly setAppLogsPath: ReturnType<typeof vi.fn>;
}): string | undefined {
  return app.setAppLogsPath.mock.calls.at(-1)?.[0];
}

/** The user-data folder `app` was pointed at, or `undefined` when it kept the default. */
function chosenUserData(app: { readonly setPath: ReturnType<typeof vi.fn> }): string | undefined {
  const call = app.setPath.mock.calls.find(([name]) => name === "userData");
  return call?.[1] as string | undefined;
}

describe("the install's profile", () => {
  it("keeps the shipped app's own folder, and gives each development checkout another", () => {
    const shipped = installApp({ isPackaged: true, appPath: "/Applications/AI Sidekicks.app" });
    const checkoutA = installApp({ isPackaged: false, appPath: "/src/a/apps/desktop" });
    const checkoutB = installApp({ isPackaged: false, appPath: "/src/b/apps/desktop" });

    keyProfileToInstall(shipped);
    keyProfileToInstall(checkoutA);
    keyProfileToInstall(checkoutB);

    expect(chosenUserData(shipped)).toBeUndefined();
    expect(chosenLogs(shipped)).toBeUndefined();
    const folderA = chosenUserData(checkoutA);
    expect(folderA).toMatch(/^\/appData-root\/appData\/AI Sidekicks development [0-9a-f]{12}$/);
    expect(chosenLogs(checkoutA)).toBe(path.join(String(folderA), PROFILE_LOGS_FOLDER_NAME));
    expect(chosenUserData(checkoutB)).not.toBe(folderA);
  });

  it("keeps a folder the launch names", () => {
    const named = installApp({ isPackaged: false, appPath: "/src/a", userDataSwitch: true });

    keyProfileToInstall(named);

    expect(chosenUserData(named)).toBeUndefined();
    expect(chosenLogs(named)).toBe(path.join("/appData-root/userData", PROFILE_LOGS_FOLDER_NAME));
  });
});
