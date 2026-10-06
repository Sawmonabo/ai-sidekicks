// What the Electron preload exposes on `window.desktopBridge`.
//
// Every namespace and `app` member is `readonly`, so a compromised renderer cannot reassign
// `bridge.daemon`. No auth material (daemon session token, PASETO tokens, DPoP key) appears here:
// `preload-api.test-d.ts` fails the typecheck when a property name the page can reach, daemon
// results and delivered values included, matches /token|dpop|secret/i and is not a credential-free
// name, a question's masked-answer flag, or one of the two credentials the design shows the person
// once, each allowed only where it is sent. Paths reach the renderer only as opaque `FilePathRef`
// values, which main mints and dereferences. Raw
// `ipcRenderer`, `require`, `process` and Node built-ins never appear.
//
// The daemon's calls and subscriptions are typed by the daemon's method map in
// `@ai-sidekicks/contracts`. Every other shape is declared here or beside this file in
// `src/shared/`, with no dependency on the `electron` package.
//
// `PreloadApi` carries the members main answers and the members the renderer already calls.
// `createStubBridge` is the same object with every round-trip member throwing
// `NotImplementedError`, the shape the live bridge is checked against.
// The request and reply types of the bridge calls not built yet are declared here as well, and
// each call joins `PreloadApi` with its main handler.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  DaemonSubscribeParams,
} from "@ai-sidekicks/contracts/daemon/methods";
import type {
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsReading,
  SettingsFileRepair,
} from "@ai-sidekicks/contracts/machine-settings";
import type { ServicePlaceLocation } from "@ai-sidekicks/contracts/service-place";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";

import type { AppFacts } from "./app-facts.js";
import type { AppearanceChoice, AppearanceGrounds, AppearanceRecord } from "./appearance.js";
import type { DaemonSubscriptionEnd } from "./daemon/forwarding.js";
import type {
  DaemonStatusRequest,
  DaemonStatusTopic,
  MainProcessState,
} from "./daemon/daemon-status-topic.js";
import type { WindowDefaultSizes, WindowSize } from "./window/window-size.js";

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
  /** The picked folder, or `null` when the person canceled. */
  readonly pickFolder: PickedFolder | null;
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

/** One folder a person picked: its token, and the folder's own name for the form to draw. */
export interface PickedFolder {
  readonly ref: FilePathRef;
  readonly name: string;
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
 */
export interface EditorEntry {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
}

/**
 * What one copy puts on the clipboard: the plain text, and a formatted flavor beside it that a
 * paste target which reads formatting takes instead.
 */
export interface ClipboardContent {
  readonly text: string;
  readonly html?: string;
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

/** What `daemon.subscribe` opens: one of the daemon's subscriptions, or main's status topic. */
export type DaemonWireTopic = DaemonEvent | DaemonStatusTopic;

/** What a topic is opened with: the request its daemon method registers, or nothing. */
export type DaemonWireRequest<E extends DaemonWireTopic> = E extends DaemonEvent
  ? DaemonSubscribeParams<E>
  : DaemonStatusRequest;

/** One value a topic delivers: its daemon method's emission, or main's state. */
export type DaemonWirePayload<E extends DaemonWireTopic> = E extends DaemonEvent
  ? DaemonEventPayload<E>
  : MainProcessState;

/**
 * What a served daemon call answers: the daemon's result, and the token main minted for each path
 * the result offers to open, keyed by the path; absent when it offers none.
 */
export interface ServedDaemonCall<Value> {
  readonly value: Value;
  readonly fileRefs?: Readonly<Record<string, FilePathRef>>;
}

/**
 * The daemon's own wire: its JSON-RPC calls, and its subscriptions, each opened with the
 * request its method registers. A call the daemon refuses rejects with the wire error itself
 * (`{code, message, data}`), and any other failed call with an `Error`; a subscription that
 * cannot open throws.
 */
export interface DaemonWire {
  call<M extends DaemonMethod>(
    method: M,
    params: DaemonParams<M>,
  ): Promise<ServedDaemonCall<DaemonResult<M>>>;
  /**
   * Open one subscription. `daemon.status` is main's own topic: it opens while no service
   * answers, its first delivery is the current state, and it never ends. A daemon subscription
   * that ends after it opened, because the daemon completed or refused it or the link under it
   * failed, calls `onEnded` once and delivers nothing more; closing it before then never does.
   */
  subscribe<E extends DaemonWireTopic>(
    event: E,
    params: DaemonWireRequest<E>,
    handler: (payload: DaemonWirePayload<E>) => void,
    onEnded?: (end: DaemonSubscriptionEnd) => void,
  ): Unsubscribe;
  /**
   * Start the background service again with a full set of attempts: the boot card's `Retry`.
   * Resolves once main has begun; the service's state reports how the start goes.
   */
  requestStart(): Promise<void>;
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
    /**
     * A token for a file dropped on the composer. Refused for a `File` the page built itself,
     * which has no path, and for a folder.
     */
    getDroppedFileRef(file: File): Promise<FilePathRef>;
    /**
     * Write a pasted picture to a file only the person can read and answer its token. The file
     * lasts until the page that pasted it goes; empty bytes are refused.
     */
    savePastedImage(bytes: ArrayBuffer): Promise<FilePathRef>;
    /** Open a web address in the system browser; refused unless it is `http:` or `https:`. */
    openExternal(url: string): Promise<void>;
    /**
     * Open a file or folder, at a line from 1 where one is given, in the editor the machine's
     * settings name, or in the system default when none is named or the named one is gone.
     */
    openInEditor(ref: FilePathRef, line?: number): Promise<void>;
    /** Every editor the app looks for, in list order, each saying whether this machine has it. */
    listEditors(): Promise<EditorEntry[]>;
    /** The operating system's notification permission for this app. */
    getNotificationPermission(): Promise<NotificationPermission>;
    /**
     * Put the text, with its formatted flavor where one is given, on the clipboard in one write.
     */
    copyToClipboard(content: ClipboardContent): Promise<void>;
    /** Show a file or folder selected in the platform's file manager. */
    revealInFileExplorer(ref: FilePathRef): Promise<void>;
  };

  /** The app's updater, in main. */
  readonly update: {
    getState(): Promise<UpdateState>;
    /** Each state main pushes; the current one is read through `getState`. */
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    requestCheck(): Promise<void>;
    requestDownload(): Promise<void>;
    requestRestart(): Promise<void>;
  };

  /**
   * The machine's settings file, carried by the service, its one writer. A refused call rejects
   * with the wire error itself, as `daemon.call` does.
   */
  readonly machineSettings: {
    /** The file as it stands, with the repair the service made since the last change. */
    read(): Promise<MachineSettingsReading>;
    /** Write one change; answers the file as written. */
    write(change: MachineSettingsChange): Promise<MachineSettings>;
    /**
     * Each written change, the first delivery the file as it stands. A feed that ends after it
     * opened calls `onEnded` once, as a daemon subscription does.
     */
    subscribe(
      handler: (reading: MachineSettingsReading) => void,
      onEnded?: (end: DaemonSubscriptionEnd) => void,
    ): Unsubscribe;
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

  /**
   * The windows a person sees, each named by its window id, the frame name the console document
   * opened it under: the one used last, the appearance, each one's minimum size, and main's asks.
   */
  readonly window: {
    /**
     * The window used last at the last quit, or a new id on a first launch. The console document
     * opens it first, and keys its kept window layout by window ids.
     */
    readonly lastUsedWindowId: string;
    /**
     * The appearance chosen and its theme's two grounds: main sets the platform scheme, ticks the
     * View menu, paints first frames from the grounds and keeps the record.
     */
    setAppearance(choice: AppearanceChoice, grounds: AppearanceGrounds): Promise<void>;
    /** The appearance record on every change, the first delivery the kept one. */
    subscribeAppearance(handler: (record: AppearanceRecord) => void): Unsubscribe;
    /** The smallest size one window may shrink to. */
    setMinimumSize(windowId: string, size: WindowSize): Promise<void>;
    /**
     * The widths a pane's own window with no kept place opens at, handed before the first window
     * opens and again when the text size changes.
     */
    setDefaultSizes(sizes: WindowDefaultSizes): Promise<void>;
    /**
     * Ends a safe start once `Restore windows` reopened the kept windows, so main keeps each
     * window's place again.
     */
    endSafeStart(): Promise<void>;
    /**
     * Main's ask to open a window again, by its id, when none a person sees is open: a Dock click
     * or a second launch.
     */
    subscribeToReopenRequest(handler: (windowId: string) => void): Unsubscribe;
  };

  readonly app: AppFacts;
}

/**
 * Thrown by every round-trip member of the stub bridge. Its `name` is stable, so a caller can test
 * it without importing the class.
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
 * `PreloadApi` as an object literal, with every round-trip member throwing `NotImplementedError`
 * and the build facts and the window used last the caller gives: the members the live bridge must
 * have, and a bridge none of whose calls reaches main.
 */
export function createStubBridge(app: AppFacts, lastUsedWindowId: string): PreloadApi {
  return {
    daemon: {
      call: () => stubThrow("daemon.call"),
      subscribe: () => stubThrow("daemon.subscribe"),
      requestStart: () => stubThrow("daemon.requestStart"),
    },
    native: {
      showOpenDialog: () => stubThrow("native.showOpenDialog"),
      getDroppedFileRef: () => stubThrow("native.getDroppedFileRef"),
      savePastedImage: () => stubThrow("native.savePastedImage"),
      openExternal: () => stubThrow("native.openExternal"),
      openInEditor: () => stubThrow("native.openInEditor"),
      listEditors: () => stubThrow("native.listEditors"),
      getNotificationPermission: () => stubThrow("native.getNotificationPermission"),
      copyToClipboard: () => stubThrow("native.copyToClipboard"),
      revealInFileExplorer: () => stubThrow("native.revealInFileExplorer"),
    },
    update: {
      getState: () => stubThrow("update.getState"),
      subscribe: () => stubThrow("update.subscribe"),
      requestCheck: () => stubThrow("update.requestCheck"),
      requestDownload: () => stubThrow("update.requestDownload"),
      requestRestart: () => stubThrow("update.requestRestart"),
    },
    machineSettings: {
      read: () => stubThrow("machineSettings.read"),
      write: () => stubThrow("machineSettings.write"),
      subscribe: () => stubThrow("machineSettings.subscribe"),
    },
    keyboardMap: {
      read: () => stubThrow("keyboardMap.read"),
      write: () => stubThrow("keyboardMap.write"),
    },
    window: {
      lastUsedWindowId,
      setAppearance: () => stubThrow("window.setAppearance"),
      subscribeAppearance: () => stubThrow("window.subscribeAppearance"),
      setMinimumSize: () => stubThrow("window.setMinimumSize"),
      setDefaultSizes: () => stubThrow("window.setDefaultSizes"),
      endSafeStart: () => stubThrow("window.endSafeStart"),
      subscribeToReopenRequest: () => stubThrow("window.subscribeToReopenRequest"),
    },
    app,
  };
}
