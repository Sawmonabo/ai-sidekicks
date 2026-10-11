// What main takes from the operating system it runs on. One module per system supplies it, and
// main's startup picks one, before ready, for everything it builds.

import type {
  AboutPanelOptionsOptions,
  BaseWindowConstructorOptions,
  MenuItemConstructorOptions,
} from "electron";

import type {
  ProcessIdentityReader,
  ProcessIdentitySystem,
} from "@ai-sidekicks/contracts/process-identity";

import type { SupportedPlatform } from "#shared/app-facts.js";
import type { MachineClockReader } from "../bridge/machine-clock/reader.js";
import type { InstalledEditors } from "../bridge/native/editors/installed.js";
import type { ProgramRunner } from "../bridge/native/editors/program-runner.js";
import type { OwnerOnlyFileOperatingSystem } from "../services/owner-only-file.js";
import type { InstallLocation } from "../services/resource-file.js";

/**
 * How a test build asked to keep out of the way puts its windows up: `hidden` leaves a window as
 * constructed, never ordered onto a screen, and `inactive` shows it without activating the app;
 * the activation policy is set before the first window, where the system has one, so the app never
 * activates and shows no Dock icon.
 */
export interface UnobtrusiveWindows {
  readonly reveal: "hidden" | "inactive";
  readonly activationPolicy?: "accessory";
}

/** The parts of the application menu and the About panel that differ by system. */
export interface ApplicationMenuParts {
  /** The keys a development build's developer-tools row opens on, as Electron spells them. */
  readonly developerToolsAccelerator: string;
  /** What the About panel shows beyond the app's name and version, which every system fills. */
  readonly aboutPanelOptions: (
    version: string,
    location: InstallLocation,
  ) => AboutPanelOptionsOptions;
  /** The menus before File. */
  readonly leadingMenus: readonly MenuItemConstructorOptions[];
  /** The menus after Window, given the app's name. */
  readonly trailingMenus: (appName: string) => readonly MenuItemConstructorOptions[];
}

/** The facts and readers of one operating system that main's windows, menus and files take. */
export interface MainOperatingSystem extends OwnerOnlyFileOperatingSystem {
  /** The system in Node's spelling, which the app's facts hand every page. */
  readonly platform: SupportedPlatform;
  /** Where the machine's region and 12- or 24-hour clock are read. */
  readonly machineClock: MachineClockReader;
  /**
   * The system's form of the installed editors, built at each call so a system whose form is not
   * built refuses only the call. Throws on such a system.
   */
  readonly installedEditors: (runProgram: ProgramRunner) => InstalledEditors;
  /** The title bar every window is built with. */
  readonly titleBar: Pick<BaseWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay">;
  /** Whether the app keeps running once the last window a person sees closes. */
  readonly keepsRunningWithNoWindow: boolean;
  /** The application menu's and the About panel's parts that differ by system. */
  readonly applicationMenu: ApplicationMenuParts;
  /** Whether the app keeps an icon in the menu bar for its whole life. */
  readonly hasMenuBarIcon: boolean;
  /**
   * A reader of the system's processes through `system`, which keeps the boot it first reads; on a
   * system whose processes are not read, each reading rejects.
   */
  readonly createProcessIdentityReader: (system: ProcessIdentitySystem) => ProcessIdentityReader;
  /**
   * How a test build asked to keep out of the way puts its windows up. Set only behind the
   * compile-time test build flag, so a release bundle carries none of it.
   */
  readonly unobtrusiveWindows?: UnobtrusiveWindows;
}
