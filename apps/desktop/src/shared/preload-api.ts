// What the Electron preload exposes on `window.desktopBridge`.
//
// Every namespace and `app` member is `readonly`, so a compromised renderer cannot reassign
// `bridge.daemon`. No auth material (daemon session token, PASETO tokens, DPoP key) appears here:
// `preload-api.test-d.ts` fails the typecheck when any property name at any depth matches
// /token|dpop|secret/i. Paths reach the renderer only as opaque `FilePathRef` values, which
// main mints and dereferences. Raw `ipcRenderer`, `require`, `process` and Node built-ins
// never appear.
//
// The daemon's calls and subscriptions are typed by the daemon's method map in
// `@ai-sidekicks/contracts`. Every other shape is declared here or beside this file in
// `src/shared/`, with no dependency on the `electron` package.
//
// `PreloadApi` carries the members main answers and the members the renderer already calls.
// A member main does not answer yet throws `NotImplementedError`; `createStubBridge` is that
// whole object, and the preload replaces the members main answers. The request and reply types
// of the bridge calls not built yet are declared here as well, and each call joins `PreloadApi`
// with its main handler.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  DaemonSubscribeParams,
} from "@ai-sidekicks/contracts/daemon-methods";
import type {
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsReading,
  SettingsFileRepair,
} from "@ai-sidekicks/contracts/machine-settings";
import type { ServicePlaceLocation } from "@ai-sidekicks/contracts/service-place";
import type { SessionId } from "@ai-sidekicks/contracts/session";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow-run";

import type { AppFacts } from "./app-facts.js";

/** Handle returned by every subscription. Idempotent: a second call does nothing. */
export type Unsubscribe = () => void;

/** Opaque reference to a file path; the renderer never sees the raw path, main dereferences it. */
export type FilePathRef = string & { readonly __brand: "FilePathRef" };

/**
 * What an open dialog answers for each purpose, which also decides what a person can pick:
 * `attachFiles` several files for the composer, `importFile` one file, `pickFolder` one folder.
 */
export interface OpenDialogResults {
  readonly attachFiles: OpenDialogResult;
  readonly importFile: OpenDialogResult;
  /** The picked folder's token, or `null` when the person canceled. */
  readonly pickFolder: FilePathRef | null;
}

/** What an open dialog is for. */
export type OpenDialogPurpose = keyof OpenDialogResults;

/** What the renderer asks an open dialog for. */
export interface OpenDialogOptions<Purpose extends OpenDialogPurpose = OpenDialogPurpose> {
  readonly purpose: Purpose;
}

/**
 * One file a person picked: its token, and the name and size a chip draws before it is read. The
 * name is the file's own name, never a folder.
 */
export interface PickedFile {
  readonly ref: FilePathRef;
  readonly name: string;
  readonly sizeBytes: number;
}

/** The files a person picked, empty when they canceled. */
export interface OpenDialogResult {
  readonly refs: readonly PickedFile[];
}

/**
 * Whether this machine will show an OS notification for this application.
 *
 * `not-determined` is the state before the person has been asked; it must not fold onto
 * `denied`, which says the notification center is the only place a notification will show.
 * `unsupported` is a platform main cannot read the permission on.
 */
export interface NotificationPermission {
  readonly state: "granted" | "denied" | "not-determined" | "unsupported";
}

/**
 * One editor the app looks for. `installed` is whether this machine has it, found through the
 * operating system's register of installed apps; one that is not can be shown, not chosen.
 *
 * @consumedBy the editor list in Settings, when main answers it
 */
export interface EditorEntry {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
}

/**
 * An install that cannot update itself, and what can: a package manager's own update
 * command, or, for a macOS copy outside a writable folder, moving it to Applications.
 */
export type UpdateSelfBlock =
  | { readonly kind: "packageManager"; readonly command: string }
  | { readonly kind: "outsideApplications" };

/**
 * Auto-update state surfaced to the renderer: one arm, and the members every arm may carry.
 *
 * `idle` carries the instant of the last completed check so the settings read-out can say when
 * its answer was established; a build that has never completed a check has none. `available`
 * is an update found and not downloaded, with its version and release instant as the update
 * feed states them. `verifying` is the updater checking the downloaded update's signature.
 */
export type UpdateState = (
  | { readonly status: "idle"; readonly lastCheckedAt?: string }
  | { readonly status: "checking" }
  | { readonly status: "available"; readonly version: string; readonly releasedAt: string }
  | { readonly status: "downloading"; readonly percent: number }
  | { readonly status: "verifying" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string }
) & {
  /** The version the updater found, on an arm that names one. */
  readonly version?: string;
  /** That version's notes, in plain sentences, drawn under `What changed`. */
  readonly notes?: string;
  /** An update a previous run staged and never applied, read at launch from the updater's cache. */
  readonly staged?: { readonly version: string };
  /** Set on an install that cannot update itself. */
  readonly cannotUpdateItself?: UpdateSelfBlock;
};

/** The step a background-service update is on. */
export type ServiceUpdateStep = "checking" | "downloading" | "verifying" | "waiting" | "restarting";

/**
 * The running work a service update waits for: the sessions and workflow runs by title, and
 * the provider sessions typed in a terminal inside the service as a count.
 */
export interface ServiceUpdateWaitingOn {
  readonly sessions: readonly { readonly sessionId: SessionId; readonly title: string }[];
  readonly workflowRuns: readonly {
    readonly workflowRunId: WorkflowRunId;
    readonly title: string;
  }[];
  readonly terminalProviderSessionCount: number;
}

/** How a service update ended. */
export type ServiceUpdateOutcome =
  | { readonly kind: "landed"; readonly fromVersion: string; readonly toVersion: string }
  | {
      readonly kind: "rolled-back";
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly reason: string;
    }
  | { readonly kind: "already-newest" };

/**
 * One delivery of a service update's progress, the first being the current state.
 * `cancelable` turns false once main has asked the old service to stop.
 *
 * @consumedBy the background service update on Settings › Runtime
 */
export interface ServiceUpdateProgress {
  readonly step: ServiceUpdateStep;
  /** While downloading, the bytes received against the release's size, from 0 to 100. */
  readonly percent: number | undefined;
  /** The work it waits on, while it waits. */
  readonly waitingOn: ServiceUpdateWaitingOn | undefined;
  readonly cancelable: boolean;
  readonly outcome: ServiceUpdateOutcome | undefined;
}

/** A provider's version where it was found in a place, or `null` where it was not. */
export type ServicePlaceProvider = { readonly version: string } | null;

/** How far main has read one place. */
export type ServicePlaceReading =
  | { readonly state: "read" }
  | { readonly state: "checking" }
  | { readonly state: "failed"; readonly reason: string };

/**
 * One place the service can run from on a Windows computer, with what was found there and
 * whether the service uses it.
 *
 * @consumedBy the places list on Windows, when main answers it
 */
export interface ServicePlace {
  readonly place: ServicePlaceLocation;
  readonly inUse: boolean;
  /** A distribution's WSL version; absent for Windows itself. */
  readonly wslVersion?: 1 | 2;
  /** A distribution's C library; absent for Windows itself. */
  readonly libc?: "glibc" | "musl";
  readonly claude: ServicePlaceProvider;
  readonly codex: ServicePlaceProvider;
  readonly reading: ServicePlaceReading;
}

/**
 * One delivery of a service move's progress, ending in `moved` or `failed`.
 *
 * @consumedBy moving the background service on Windows
 */
export type ServiceMoveProgress =
  | { readonly step: "installing" }
  | { readonly step: "stopping" }
  | { readonly step: "copying"; readonly bytesDone: number; readonly bytesTotal: number }
  | { readonly step: "starting" }
  | { readonly step: "reconnecting" }
  | { readonly step: "moved" }
  | {
      readonly step: "failed";
      readonly reason: string;
      /** The worktrees the undo could not put back, by name. */
      readonly notRestored?: { readonly worktrees: readonly string[] };
    };

/**
 * The keyboard map: only the rows that differ from the shipped chord, keyed by the act's
 * command id. A chord string rebinds the act; `null` leaves it with no chord.
 */
export type KeyboardMap = Readonly<Record<string, string | null>>;

/**
 * The keyboard map as main read it, and the repair it made when the file was broken: a broken
 * file reads as the shipped chords and main writes that back.
 */
export interface KeyboardMapReading {
  readonly map: KeyboardMap;
  readonly repair?: SettingsFileRepair;
}

/**
 * A preview pane: the one session whose active page it shows.
 *
 * @consumedBy the Preview pane's page host in main
 */
export interface BrowserPane {
  readonly sessionId: SessionId;
}

/**
 * A pane's rectangle in the window's content area, in CSS pixels.
 *
 * @consumedBy the Preview pane's page host in main
 */
export interface BrowserPaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * An act the pane performs on its page: its own editing, copying its address, and moving focus
 * into it. Back, forward and reload are the daemon's navigation, so history has one owner.
 *
 * @consumedBy the Preview pane's page host in main
 */
export type BrowserPaneAct = "cut" | "copy" | "paste" | "selectAll" | "copyLink" | "focus";

/**
 * A captured page, for marks: PNG bytes, their size, and the scale read from the image.
 *
 * @consumedBy the Preview pane's page host in main
 */
export interface CapturedPage {
  readonly image: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

/**
 * Something that happened to a pane's page that the pane shows.
 *
 * @consumedBy the Preview pane's page host in main
 */
export type BrowserPaneEvent =
  | { readonly kind: "downloadRefused"; readonly fileName: string }
  | { readonly kind: "pageCrashed" };

/**
 * A window's minimum size, in CSS pixels.
 *
 * @consumedBy the window's minimum size call to main
 */
export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The daemon's own wire: its JSON-RPC calls, and its subscriptions, each opened with the
 * request its method registers.
 */
export interface DaemonWire {
  call<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>;
  subscribe<E extends DaemonEvent>(
    event: E,
    params: DaemonSubscribeParams<E>,
    handler: (payload: DaemonEventPayload<E>) => void,
  ): Unsubscribe;
}

/**
 * The one object the preload exposes on `window.desktopBridge`: the daemon's wire, the OS calls
 * main makes for the renderer, the updater, the machine settings, the keyboard map, and build
 * facts.
 */
export interface PreloadApi {
  readonly daemon: DaemonWire;

  readonly native: {
    showOpenDialog<Purpose extends OpenDialogPurpose>(
      options: OpenDialogOptions<Purpose>,
    ): Promise<OpenDialogResults[Purpose]>;
    /** Open a web address in the system browser; refused unless it is `http:` or `https:`. */
    openExternal(url: string): Promise<void>;
    copyToClipboard(text: string): Promise<void>;
  };

  readonly update: {
    getState(): Promise<UpdateState>;
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    requestCheck(): Promise<void>;
    requestDownload(): Promise<void>;
    requestRestart(): Promise<void>;
  };

  /** The machine's settings file, carried by the service's live read and its one writer. */
  readonly machineSettings: {
    /** Write one change; answers the file as written. */
    write(change: MachineSettingsChange): Promise<MachineSettings>;
    /** Each written change, the first delivery the file as it stands. */
    subscribe(handler: (reading: MachineSettingsReading) => void): Unsubscribe;
  };

  /**
   * The keyboard map, main's own file. No change feed: one renderer drives every window, so
   * one reader holds the map.
   */
  readonly keyboardMap: {
    read(): Promise<KeyboardMapReading>;
    /** Replace the whole map; answers the map as stored. */
    write(map: KeyboardMap): Promise<KeyboardMap>;
  };

  readonly app: AppFacts;
}

/**
 * Thrown by a preload member main has no handler for yet. Its `name` is stable, so a caller can
 * test it without importing the class.
 */
export class NotImplementedError extends Error {
  public constructor(member: string) {
    super(`The bridge member ${member} has no handler in the main process yet.`);
    this.name = "NotImplementedError";
  }
}

function stubThrow(member: string): never {
  throw new NotImplementedError(member);
}

/**
 * The preload API with every round-trip member throwing `NotImplementedError`. The caller
 * supplies the build facts, because only the preload can read what main passed.
 */
export function createStubBridge(app: AppFacts): PreloadApi {
  return {
    daemon: {
      call: () => stubThrow("daemon.call"),
      subscribe: () => stubThrow("daemon.subscribe"),
    },
    native: {
      showOpenDialog: () => stubThrow("native.showOpenDialog"),
      openExternal: () => stubThrow("native.openExternal"),
      copyToClipboard: () => stubThrow("native.copyToClipboard"),
    },
    update: {
      getState: () => stubThrow("update.getState"),
      subscribe: () => stubThrow("update.subscribe"),
      requestCheck: () => stubThrow("update.requestCheck"),
      requestDownload: () => stubThrow("update.requestDownload"),
      requestRestart: () => stubThrow("update.requestRestart"),
    },
    machineSettings: {
      write: () => stubThrow("machineSettings.write"),
      subscribe: () => stubThrow("machineSettings.subscribe"),
    },
    keyboardMap: {
      read: () => stubThrow("keyboardMap.read"),
      write: () => stubThrow("keyboardMap.write"),
    },
    app,
  };
}
