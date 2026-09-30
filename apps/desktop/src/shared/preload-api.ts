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
// `@ai-sidekicks/contracts`. The control plane's procedure types are stubs until it serves a
// procedure. Every other shape is declared here or beside this file in `src/shared/`, with no
// dependency on the `electron` package.
//
// A member whose main handler is not built throws `NotImplementedError`; `createStubBridge`
// is that whole object, and the preload replaces the members main answers.

import type {
  AppLinkTarget,
  BackupId,
  BrowserPageChord,
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonParams,
  DaemonResult,
  DaemonSubscribeParams,
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsReading,
  ServicePlaceLocation,
  SessionId,
  SettingsFileRepair,
  WorkflowRunId,
} from "@ai-sidekicks/contracts";

import type { AppFacts } from "./app-facts.js";
import type { AppearanceGrounds, AppearanceRecord } from "./appearance.js";
import type { DAEMON_STATUS_TOPIC, MainProcessState } from "./daemon-status-topic.js";

/** Control-plane tRPC procedure name brand (stub until the control plane serves a procedure). */
export type CpProcedure = string & { readonly __cp_procedure__: never };

/** Control-plane procedure input (stub). */
export type CpInput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Control-plane procedure output (stub). */
export type CpOutput<P extends CpProcedure> = P extends CpProcedure ? unknown : never;

/** Relay subscription event handler (stub). */
export type RelayEventHandler = (event: unknown) => void;

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

/** One file a person picked: its token, and the name and size a chip draws before it is read. */
export interface PickedFile {
  readonly ref: FilePathRef;
  readonly name: string;
  readonly sizeBytes: number;
}

/** The files a person picked, empty when they canceled. */
export interface OpenDialogResult {
  readonly refs: readonly PickedFile[];
}

/** Electron `MessageBoxOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageBoxOptions {}
/** Electron `MessageBoxReturnValue` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MessageBoxResult {}
/** Electron `NotificationConstructorOptions` shape (stub). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NotificationOptions {}

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
 * the terminal Codex sessions inside the service as a count.
 */
export interface ServiceUpdateWaitingOn {
  readonly sessions: readonly { readonly sessionId: SessionId; readonly title: string }[];
  readonly workflowRuns: readonly {
    readonly workflowRunId: WorkflowRunId;
    readonly title: string;
  }[];
  readonly terminalCodexSessionCount: number;
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
 */
export interface ServiceUpdateProgress {
  readonly step: ServiceUpdateStep;
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

/** One delivery of a service move's progress, ending in `moved` or `failed`. */
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

/** A preview pane: the one session whose active page it shows. */
export interface BrowserPane {
  readonly sessionId: SessionId;
}

/** A pane's rectangle in the window's content area, in CSS pixels. */
export interface BrowserPaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * An act the pane performs on its page: its own editing, copying its address, and moving focus
 * into it. Back, forward and reload are the daemon's navigation, so history has one owner.
 */
export type BrowserPaneAct = "cut" | "copy" | "paste" | "selectAll" | "copyLink" | "focus";

/** A captured page, for marks: PNG bytes, their size, and the scale read from the image. */
export interface CapturedPage {
  readonly image: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

/** Something that happened to a pane's page that the pane shows. */
export type BrowserPaneEvent =
  | { readonly kind: "downloadRefused"; readonly fileName: string }
  | { readonly kind: "pageCrashed" };

/** A window's minimum size, in CSS pixels. */
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
 * The one object the preload exposes on `window.desktopBridge`: the daemon's calls and the
 * supervisor's acts, the control plane, OS calls main makes for the renderer, the updater,
 * machine settings, the keyboard map, window acts, the preview pane's page host, and build meta.
 */
export interface PreloadApi {
  readonly daemon: DaemonWire & {
    /** The supervisor's own topic, which main publishes beside the daemon's subscriptions. */
    subscribe(
      topic: typeof DAEMON_STATUS_TOPIC,
      handler: (state: MainProcessState) => void,
    ): Unsubscribe;
    /** Start the service. The state it reaches rides the `daemon.status` topic. */
    requestStart(): Promise<void>;
    /** Update the service; it waits for running work to finish and never stops work. */
    requestUpdate(): Promise<void>;
    /** Cancel the service update, until main has asked the old service to stop. */
    cancelUpdate(): Promise<void>;
    subscribeUpdate(handler: (progress: ServiceUpdateProgress) => void): Unsubscribe;
    /** Replace the service's data with a backup's; the passphrase only where it is needed. */
    requestRestore(backupId: BackupId, passphrase?: string): Promise<void>;
    /** The places the service can run from; answered before any service exists. */
    listPlaces(): Promise<readonly ServicePlace[]>;
    /** Each place's reading as it lands, the first delivery the list as it stands. */
    subscribePlaces(handler: (places: readonly ServicePlace[]) => void): Unsubscribe;
    /** Move the service to another place. */
    requestMove(place: ServicePlaceLocation): Promise<void>;
    /** Cancel the move, until the old service is asked to stop. */
    cancelMove(): Promise<void>;
    subscribeMove(handler: (progress: ServiceMoveProgress) => void): Unsubscribe;
  };

  readonly controlPlane: {
    /**
     * Forwards a control-plane request/response procedure. The renderer never negotiates the
     * relay: main does and consumes its token in-process, and the renderer reaches the relay
     * only through `subscribeRelay`.
     */
    call<P extends CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>;
    subscribeRelay(sessionId: SessionId, handler: RelayEventHandler): Unsubscribe;
  };

  readonly native: {
    showOpenDialog<Purpose extends OpenDialogPurpose>(
      options: OpenDialogOptions<Purpose>,
    ): Promise<OpenDialogResults[Purpose]>;
    /** The chosen file's token, or `null` when the person canceled. */
    showSaveDialog(): Promise<FilePathRef | null>;
    /** A file dropped on the page: the preload reads its path and main mints the token. */
    getDroppedFileRef(file: File): Promise<FilePathRef>;
    /** A picture pasted on the page: main writes the bytes to a temporary file. */
    savePastedImage(bytes: Uint8Array): Promise<FilePathRef>;
    showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult>;
    showNotification(options: NotificationOptions): void;
    getNotificationPermission(): Promise<NotificationPermission>;
    /** Open a web address in the system browser; refused unless it is `http:` or `https:`. */
    openExternal(url: string): Promise<void>;
    copyToClipboard(text: string): Promise<void>;
    /** Open a file, at a line where one is given, in the editor Settings names. */
    openInEditor(ref: FilePathRef, line?: number): Promise<void>;
    /** Open the session's own folder in the platform's terminal. */
    openInTerminal(target: { readonly sessionId: SessionId }): Promise<void>;
    revealInFileExplorer(ref: FilePathRef): Promise<void>;
    /** Every editor the app looks for, installed or not. */
    listEditors(): Promise<readonly EditorEntry[]>;
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
    read(): Promise<MachineSettingsReading>;
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

  readonly window: {
    /** A `sidekicks://` link, or a notification's press, asks to show its target. */
    subscribeToNavigationRequest(handler: (target: AppLinkTarget) => void): Unsubscribe;
    /** Keep the appearance record, tell the platform, and tick the View menu's scheme. */
    setAppearance(appearance: AppearanceRecord, grounds: AppearanceGrounds): Promise<void>;
    /** The record, to every console window, and to a document once it has loaded. */
    subscribeAppearance(handler: (appearance: AppearanceRecord) => void): Unsubscribe;
    /** Whether the window is fullscreen, the first delivery being the current state. */
    subscribeFullscreen(handler: (fullscreen: boolean) => void): Unsubscribe;
    setMinimumSize(size: WindowSize): Promise<void>;
  };

  readonly browser: {
    /** Place the pane's page over its rectangle; `null` hides it. */
    publishPaneRect(pane: BrowserPane, rect: BrowserPaneRect | null): void;
    act(pane: BrowserPane, act: BrowserPaneAct): Promise<void>;
    capturePage(pane: BrowserPane): Promise<CapturedPage>;
    subscribe(pane: BrowserPane, handler: (event: BrowserPaneEvent) => void): Unsubscribe;
    /** The chords the console keeps while focus is in the page, in the key map's spelling. */
    publishPageChords(chords: readonly string[]): void;
    /** Each of those chords pressed while focus is in the page. */
    subscribePageChords(handler: (press: BrowserPageChord) => void): Unsubscribe;
  };

  readonly app: AppFacts;
}

/**
 * Thrown by a preload method whose IPC handler is not wired yet. Its `name` is stable, so a
 * caller can test it without importing the class.
 */
export class NotImplementedError extends Error {
  public constructor(method: string) {
    super(`PreloadApi.${method} is not implemented (stub).`);
    this.name = "NotImplementedError";
  }
}

function stubThrow(method: string): never {
  throw new NotImplementedError(method);
}

/**
 * The preload API with every round-trip method throwing `NotImplementedError`. The caller
 * supplies the build meta, because only the preload can read what main passed.
 */
export function createStubBridge(app: AppFacts): PreloadApi {
  return {
    daemon: {
      call: () => stubThrow("daemon.call"),
      subscribe: () => stubThrow("daemon.subscribe"),
      requestStart: () => stubThrow("daemon.requestStart"),
      requestUpdate: () => stubThrow("daemon.requestUpdate"),
      cancelUpdate: () => stubThrow("daemon.cancelUpdate"),
      subscribeUpdate: () => stubThrow("daemon.subscribeUpdate"),
      requestRestore: () => stubThrow("daemon.requestRestore"),
      listPlaces: () => stubThrow("daemon.listPlaces"),
      subscribePlaces: () => stubThrow("daemon.subscribePlaces"),
      requestMove: () => stubThrow("daemon.requestMove"),
      cancelMove: () => stubThrow("daemon.cancelMove"),
      subscribeMove: () => stubThrow("daemon.subscribeMove"),
    },
    controlPlane: {
      call: () => stubThrow("controlPlane.call"),
      subscribeRelay: () => stubThrow("controlPlane.subscribeRelay"),
    },
    native: {
      showOpenDialog: () => stubThrow("native.showOpenDialog"),
      showSaveDialog: () => stubThrow("native.showSaveDialog"),
      getDroppedFileRef: () => stubThrow("native.getDroppedFileRef"),
      savePastedImage: () => stubThrow("native.savePastedImage"),
      showMessageBox: () => stubThrow("native.showMessageBox"),
      showNotification: () => stubThrow("native.showNotification"),
      getNotificationPermission: () => stubThrow("native.getNotificationPermission"),
      openExternal: () => stubThrow("native.openExternal"),
      copyToClipboard: () => stubThrow("native.copyToClipboard"),
      openInEditor: () => stubThrow("native.openInEditor"),
      openInTerminal: () => stubThrow("native.openInTerminal"),
      revealInFileExplorer: () => stubThrow("native.revealInFileExplorer"),
      listEditors: () => stubThrow("native.listEditors"),
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
      subscribeToNavigationRequest: () => stubThrow("window.subscribeToNavigationRequest"),
      setAppearance: () => stubThrow("window.setAppearance"),
      subscribeAppearance: () => stubThrow("window.subscribeAppearance"),
      subscribeFullscreen: () => stubThrow("window.subscribeFullscreen"),
      setMinimumSize: () => stubThrow("window.setMinimumSize"),
    },
    browser: {
      publishPaneRect: () => stubThrow("browser.publishPaneRect"),
      act: () => stubThrow("browser.act"),
      capturePage: () => stubThrow("browser.capturePage"),
      subscribe: () => stubThrow("browser.subscribe"),
      publishPageChords: () => stubThrow("browser.publishPageChords"),
      subscribePageChords: () => stubThrow("browser.subscribePageChords"),
    },
    app,
  };
}
