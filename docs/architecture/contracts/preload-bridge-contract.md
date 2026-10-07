# Preload Bridge Contract

The preload bridge that [Spec-021: Desktop App And Renderer](../../specs/021-desktop-app-and-renderer.md) requires.

The preload script exposes a single typed object on `window.desktopBridge` via `contextBridge.exposeInMainWorld`. The object surface must be declarative, narrow, and capability-scoped. The one other global the preload exposes is a fixture launch, on a page global of its own and only in a fixture-capable build ([Spec-021 §Fixtures](../../specs/021-desktop-app-and-renderer.md#fixtures)); it is never a member of this object.

**One bridge for every window.** One renderer drives every window, so the bridge is exposed once, to that renderer's hidden console document. Every window a person sees — a window of session views, the first included, and a side pane's own window — is that document's `window.open` child, which carry no preload and no bridge of their own: nothing crosses the bridge for a view or for a detached pane ([Spec-021 §Detached panes](../../specs/021-desktop-app-and-renderer.md#detached-panes)).

**One interface, three hosts.** The same front end runs in the desktop app, the web client and the phone apps, and the bridge is one typed interface, `PlatformBridge`, the front end's host-agnostic capability boundary, declared in the renderer's `services/platform/` with `PlatformBridgeProvider`, through which the renderer receives it. The provider hands down, beside the bridge, the clock the window runs on — real time for a window that reads the preload, and a fixture composition's own clock for a window that composition builds — so neither the clock nor a fixture's scenario engine is a member of any bridge. No bridge carries an attention member either: the rail's count and the notification surface read the attention projection through `daemon`, as `attention.projectionRead`, the whole projection and then every change. It has three implementations: the desktop's, which alone reads the Electron preload's `window.desktopBridge`; the browser's in the web client; and Capacitor's in the phone apps. The other hosts expose nothing on `window`. The preload's object is the desktop's implementation detail, typed by the desktop's preload API type, `PreloadApi` (`apps/desktop/src/shared/preload-api.ts`), and the daemon method map both types import (`DaemonMethod`, `DaemonParams`, `DaemonResult`, `DaemonEvent`) is in `packages/contracts`. A member a host cannot serve is absent from that host's bridge, so its control is absent from the screen, never drawn and refused; the web client and the phone apps reach a machine over the relay ([Spec-027](../../specs/027-remote-control.md)).

```ts
// what main asks the console to bring forward, from a `sidekicks://` link, `sidekicks open` or a notification click: the parsed link's target, its id and nothing else
type NavigationRequest =
  | { kind: "session"; sessionId: SessionId }
  | { kind: "workflowRun"; workflowRunId: WorkflowRunId };

// a Preview pane, named by its session; main maps it to that session's open page
type PaneRef = { sessionId: SessionId };

// where the pane's page sits, in the content coordinates of the window that holds the pane
type PaneRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  clip: { x: number; y: number; width: number; height: number }; // the part left visible by everything that clips the pane
  visible: boolean; // false while an overlay covers the page, a tool holds it frozen or its pane is moving
  pointerPassThrough: boolean; // true while a pane edge is under the pointer, so a drag never sticks on the page
};

interface PlatformBridge {
  // daemon RPC over the Spec-006 JSON-RPC contract, and the supervisor main runs beside it
  daemon: {
    // one daemon method, forwarded over main's own connection, which presented the session token
    call<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>;
    // one daemon subscription and its request; the `daemon.status` topic, opened with `{}`, carries
    // the connection state and the version range. `onEnded` hears, once, a subscription that ended
    // without the page closing it: `completed`, `refused` with the wire error, or `failed`
    // `DaemonWireTopic` is every `DaemonEvent` and `daemon.status`; the request and payload types follow the topic
    subscribe<E extends DaemonWireTopic>(
      event: E,
      params: DaemonWireRequest<E>,
      handler: (payload: DaemonWirePayload<E>) => void,
      onEnded?: (end: DaemonSubscriptionEnd) => void,
    ): Unsubscribe;
    // start the service: the boot card's `Retry`
    requestStart(): Promise<void>;
    // update the service; it waits for running work to finish and never stops it (Spec-006)
    requestUpdate(): Promise<void>;
    // cancel the service update, honored until main asks the old service to stop (Spec-006)
    cancelUpdate(): Promise<void>;
    // the service update's steps, the first delivery the current state (Spec-006)
    subscribeUpdate(handler: (update: ServiceUpdateProgress) => void): Unsubscribe;
    // `Restore…`: main stops the service, puts the backup's data in place and starts it again
    requestRestore(backupId: string): Promise<void>;
    // on a Windows computer with WSL 2, the places Claude Code and Codex can run from (Spec-006)
    listPlaces(): Promise<ServicePlace[]>;
    // each place's reading as it lands, the first delivery the list as it stands (Spec-006)
    subscribePlaces(handler: (places: ServicePlace[]) => void): Unsubscribe;
    // move the service to another place with its move set (Spec-006)
    requestMove(place: ServicePlace["place"]): Promise<void>;
    // cancel the move, honored until the old service is asked to stop (Spec-006)
    cancelMove(): Promise<void>;
    // the move's steps, then `moved` or `failed` (Spec-006)
    subscribeMove(handler: (move: ServiceMoveState) => void): Unsubscribe;
  };

  // control-plane RPC — request/response over tRPC, carried by the background service; the control plane pushes no presence: a device's connected state comes from `device.list`, and a machine's presence is read over its channel (`presence.read`, `presence.subscribe`); relay traffic rides the relay's binary wire frames. The control plane holds no session: another device reaches a session only through its machine over the relay ([Spec-027](../../specs/027-remote-control.md)), and this app reaches another machine's sessions the same way, through `daemon` on the machine in view. The `PlatformBridge` type matches this block, the desktop's preload API type carries the same namespaces, and a namespace joins them only where a spec section names its owner
  controlPlane: {
    // one control-plane procedure, forwarded by main to the background service, which sends it under this machine's credentials
    call<P extends CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>;
  };

  // native capabilities — renderer requests, main performs, sanitized result returned
  native: {
    // the platform's chooser for one of its purposes (attach files, pick a folder, import one file); returns tokens, never a path
    showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
    // the platform's save chooser for an export's destination; returns a token
    showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
    // a file dropped on the composer: the preload reads its path and hands it to main, which mints the token
    getDroppedFileRef(file: File): Promise<FilePathRef>;
    // a pasted picture: main writes the bytes to a temporary file and mints its token
    savePastedImage(bytes: ArrayBuffer): Promise<FilePathRef>;
    // an outside address in the system browser, checked against main's allowlist
    openExternal(url: string): Promise<void>;
    // the working folder, or a file at a line, in the editor named in Settings
    openInEditor(ref: FilePathRef, line?: number): Promise<void>;
    // the session's own folder in the platform's own terminal app
    openInTerminal(request: { sessionId: SessionId }): Promise<void>;
    // every editor the app looks for, in list order, each saying whether this machine has it, found through the system's app registry
    listEditors(): Promise<EditorEntry[]>;
    // the operating system's notification permission for this app
    getNotificationPermission(): Promise<NotificationPermission>;
    // one clipboard write: a plain line, or the text with a formatted flavor beside it (main's `clipboard.write`)
    copyToClipboard(content: { text: string; html?: string }): Promise<void>;
    // the clipboard's plain text, read for a paste into a page on another machine (main's `clipboard.readText`)
    readClipboardText(): Promise<string>;
    // a file or folder shown in the platform's file manager
    revealInFileExplorer(path: FilePathRef): Promise<void>;
  };

  // the `browser` pane's native page hosts — the renderer measures, main performs (ADR-034); the renderer owns no page
  browser: {
    // the rectangle the pane's page is positioned to; null hides the page
    publishPaneRect(pane: PaneRef, rect: PaneRect | null): void;
    // an editing or focus act on the page (cut, copy, paste, select all, copy link, focus), or
    // `inspect`, which opens the page's developer tools docked at the bottom or closes them
    act(pane: PaneRef, act: BrowserPaneAct): Promise<void>;
    // the page as a picture for marking, its scale read from the image
    capturePage(pane: PaneRef): Promise<CapturedPageImage>;
    // page-host events for the pane, `downloadOffered` and `downloadRefused` among them
    subscribe(pane: PaneRef, handler: (event: BrowserPaneEvent) => void): Unsubscribe;
    // on this machine's own desktop window, the system save dialog for the download the pane's page
    // offered; main writes the file where the person chose, and a canceled dialog writes nothing
    saveDownload(pane: PaneRef): Promise<void>;
    // the bound chords the console keeps while focus is in the page, replacing the last set, and
    // `Inspect`'s, which main claims there whatever their modifiers and matches inside its tools
    publishPageChords(chords: ChordDescriptor[], inspectChords: ChordDescriptor[]): void;
    // a kept chord pressed while the page has focus, handed back by main
    subscribePageChords(handler: (chord: ChordDescriptor) => void): Unsubscribe;
  };

  // the windows a person sees, each named by the window id its frame name carries — their appearance, size and the requests main routes to the console
  window: {
    // the window used last at the last quit, a new id on a first launch; the hidden console document opens it first and keys the kept layout by window ids
    readonly lastUsedWindowId: string;
    // the appearance chosen: main mirrors the scheme into the platform and the View menu, keeps the record and paints first frames from `grounds`
    setAppearance(
      appearance: Pick<AppearanceRecord, "theme" | "scheme" | "textSize" | "transcriptWidth">,
      grounds: { light: string; dark: string },
    ): Promise<void>;
    // the appearance record, to the console document, the change it made itself included
    subscribeAppearance(handler: (record: AppearanceRecord) => void): Unsubscribe;
    // one window's minimum size, summed from the console's width tokens and set again when the text size changes
    setMinimumSize(windowId: string, size: { width: number; height: number }): Promise<void>;
    // the width a pane's own window with no kept place opens at, read from the console's width tokens and keyed by the pane kind as its frame name carries it, handed before the first window opens and again when the text size changes
    setDefaultSizes(sizes: { paneWidths: Record<string, number> }): Promise<void>;
    // ends a safe start once `Restore windows` reopened the kept windows, so main keeps each window's place again
    endSafeStart(): Promise<void>;
    // main's ask, by window id, to open the window used last again when no window a person sees is open: a Dock click or a second launch carrying no link
    subscribeToReopenRequest(handler: (windowId: string) => void): Unsubscribe;
    // a session view dragged by its title past its window's edge: the id of the app's window under a point on the screen, hit-tested by main against its registry's window bounds, never the hidden console window; null over the desktop or another app
    findWindowAt(point: { x: number; y: number }): Promise<string | null>;
    // the drag passed every window: main starts moving the window the renderer opened for the torn-off view, keeping the point the title was grabbed at under the pointer
    startTearOff(windowId: string, grabOffset: { x: number; y: number }): Promise<void>;
    // one pointer move during a tear-off: main moves the torn-off window to the pointer's point on the screen
    moveTearOff(point: { x: number; y: number }): void;
    // released over the desktop or canceled: main stops moving the torn-off window and leaves it where it is
    endTearOff(): Promise<void>;
    // released over another of the app's windows: main stops moving any torn-off window and brings that window forward, while the renderer moves the view into its row and closes the window the view left if it holds no view
    dockView(targetWindowId: string): Promise<void>;
    // a `sidekicks://` address or a notification click, which main hands over for the renderer to route; main holds the latest one until the console document first subscribes, which receives it first, once
    subscribeToNavigationRequest(handler: (request: NavigationRequest) => void): Unsubscribe;
  };

  // the machine's settings file, which the background service alone writes
  machineSettings: {
    // the service's live read of the file, with the repair it made since the last change
    read(): Promise<MachineSettingsReading>;
    // one change, handed to the service's `daemon.machineSettingsUpdate`; answered with the file as written
    write(change: MachineSettingsChange): Promise<MachineSettings>;
    // each written change to every window, the first delivery the current file; ends as `daemon.subscribe` does
    subscribe(
      handler: (reading: MachineSettingsReading) => void,
      onEnded?: (end: DaemonSubscriptionEnd) => void,
    ): Unsubscribe;
  };

  // the keyboard map, main's own owner-only file of the overridden rows; no feed, since one renderer holds it
  keyboardMap: {
    // the overridden rows as stored, with the repair main made when the file was broken
    read(): Promise<KeyboardMapReading>;
    // the whole map, written atomically; answered with the map as stored
    write(map: KeyboardMap): Promise<KeyboardMap>;
    // each key a row of the installed application menu holds, with that row's label and its menu's, so a rebind onto one is refused
    readMenuKeys(): Promise<MenuKey[]>;
  };

  // auto-update — renderer observes state; main process drives
  update: {
    // the app update's state, with the found version, its notes, `staged` and whether this install can update itself
    getState(): Promise<UpdateState>;
    // each change to that state
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    // check the feed at once
    requestCheck(): Promise<void>;
    // download the update found
    requestDownload(): Promise<void>;
    // apply on relaunch, asking nothing: the service, every run and every shell keep running
    requestRestart(): Promise<void>;
  };

  // app meta — read-only
  app: {
    version: string; // the running app's version
    platform: "darwin" | "linux" | "win32"; // the operating system
    arch: "arm64" | "x64"; // the processor architecture
    locale: string; // the system locale
    physicalMemoryBytes: number; // the machine's physical memory, of which the screen's cache budgets are a share
    // after a session's decoded pictures are released: frees the cached memory nothing draws any more (`webFrame.clearCache()`)
    freeUnusedMemory(): void;
  };
}
```

**What each region of the console reads.** Every fact on a console surface arrives through `daemon.call` or `daemon.subscribe` and is rendered as received. Each session view reads the session's identity, shape (project or chat), project, worktree and base, status, elapsed, ahead count, snapshot count, whether its notifications are muted, pending worktree move, the unsent draft and its staged files, the files each user turn carried, and the spend rows of the session cost receipt's per-account axis. The transcript reads the user's turns, the agent's prose, its reasoning, and the state-changing rows the console itself appends, and per tool run its verb, target, live elapsed or final duration, result summary, diff hunks, failure mark and held mark. The agents pane reads each child's identity, parent, model, the agent that was asked where it was a peer call, state, activity, tools, tokens, spend, timer, transcript rows and stream, the stream running only while a view is open on that child. The approvals card reads the one pending request with its title, summary, raising child and its answers. The worktree switcher reads the per-project list with its ahead, dirty and occupancy figures, the root branch and setup progress. The `diff` pane reads the scope tabs, the base list, the files with their hunks, the commits, the pull-request state, its checks and threads, the held notes and the staleness signal. The `terminal` pane reads the session's shell output and each shell's control lease. The working line reads the running commands of the session — identity, command text, folder, start, the tool row each belongs to, output as it prints, and the end with its result and duration — the tokens received this turn, and the turn's task list. The `browser` pane reads the open page's address, title and whether its history has anywhere to go, the discovered development servers with their port and framework where one is known, which machine the page runs on, and the staged marks. The rail's attention count and the notification surface read one attention projection, and the main process reads the same projection for the count on the app icon and the operating-system notifications it posts.

**Where the embedded browser's calls go.** The session's page verbs are daemon methods under `preview.*`, reached through `daemon.call` and `daemon.subscribe` like any other: the open pages, live, each with its address, title, favicon, load state, history depth, order, zoom and whether it is released (`preview.pageList`); open one (`preview.pageOpen`), close one (`preview.pageClose`), make one the open one (`preview.pageActivate`) and move one to a new place in the strip (`preview.pageReorder`); navigate, which also serves back, forward and reload (`preview.navigate`); set a page's zoom factor, which main applies with `setZoomFactor` (`preview.zoom`); subscribe to the discovered development servers (`preview.devServerList`); send the marks attachment (`preview.marksSend`); and subscribe to the screencast, which is another device's path only (`preview.screencastSubscribe`). So are the machine-wide site-data verbs under `browser.*`, which are what the Browser settings page reads and writes: list the sites with saved data, each row saying whether it holds an unexpired cookie (`browser.siteDataList`, `hasCookies`); open one site in a page that belongs to no session, so the person signs in to it (`browser.siteSignIn {origin}`); clear one site's cookies (`browser.siteCookiesClear {origin}`); forget one site (`browser.siteDataForget`); clear all of it (`browser.siteDataClear`); and read which Chromium the daemon uses and fetch it again (`browser.chromiumRead`, `browser.chromiumFetch`). The two browser switches, `Remember site data` and `Browser tools for sidekicks`, are not a verb: they live in the machine's settings file, which the daemon reads each time it launches the headless browser or a provider. The daemon reaches the desktop's page host over main's own connection to it, never through this bridge: main reports each page view (`preview.pageTargetReport {pageId, targetId}`) and carries the debugger's traffic both ways (`preview.pageDebuggerSend`, `preview.pageDebuggerReport`); it reads and writes cookies when one host takes over from the other, and never continuously (`preview.pageCookiesRead`, `preview.pageCookiesWrite`): Playwright's `storageState` cookies are mapped onto Electron's `CookiesSetDetails` (`expires` to `expirationDate`), local storage and IndexedDB are copied by script, and passkeys do not cross and are done again on each host, which the console says rather than silently dropping a login; it clears one site's cookies (`preview.pageCookiesClear`) and one site's or every site's data (`preview.pageSiteDataClear {origins?}`, no origins meaning all), answering each clear with `ses.clearData` per registrable domain; and it turns a popup a page opens into a page through `preview.pageOpen`, never a window. The `browser` bridge namespace above is a different surface with a different owner: it is main-process work on this machine's own pages, and it carries no session state. The agent's own browser tools are on neither surface — they are the tool server the daemon hosts, `playwright-core`'s `tools.createConnection` with one connection per session, which the provider process reaches over loopback HTTP through the session's one tool-server entry, and the renderer learns of a browser act exactly as it learns of any tool call, as a row in the transcript.

**Addresses handed outward.** Every address the console hands outward goes through `native.openExternal`, which main checks against its allowlist, except a loopback address printed in a tool row or a shell, which opens in the `browser` pane instead, and one in a reply pressed with the platform modifier, which opens there too while a plain press opens the machine's own browser; an address main refuses is refused in words on the surface that asked, never silently dropped.

The bridge must not expose:

- raw `ipcRenderer` or `ipcMain`
- `require`, `process`, `global`, or any Node built-in
- auth material (daemon session token, PASETO tokens — including the relay `connectionToken`, a PASETO v4.public `aud=relay-connect` credential — DPoP key) in any form — every control-plane token and key, the relay `connectionToken` among them, is the background service's and never reaches main (relay negotiation runs in the service — see [Spec-021 §Interfaces And Contracts](../../specs/021-desktop-app-and-renderer.md#interfaces-and-contracts)), so none can cross the bridge
- arbitrary file paths as strings — path-as-capability never crosses the bridge as a raw string, in either direction. Every native or file-system operation the renderer requests takes or returns opaque `FilePathRef` tokens: the platform's choosers (`native.showOpenDialog`, `native.showSaveDialog`) return tokens; a file dropped on the composer reaches main as a path the preload reads with `webUtils.getPathForFile` and comes back as a token (`native.getDroppedFileRef`); and a pasted picture is written to a temporary file by main and comes back as a token (`native.savePastedImage`). Main's relay turns a token into the path a daemon verb needs, and mints a token for each path a daemon reply offers to open, which `native.openInEditor` and `native.revealInFileExplorer` then take; tokens live only in main's memory, and dereferencing one is a main-process step. A daemon verb that acts on a picked file takes its token — agent and workflow import and export are daemon verbs that take the picked file — and `session.attachmentAdd` takes only a token: main's relay refuses a raw path string on it. On a Windows computer whose service runs in a WSL 2 distribution, a token dereferences to the Windows form of the path the daemon supplies, and main never builds a Linux path. On such a computer a file dropped on the composer is staged to the daemon as bytes: main reads the dropped file and hands the service its contents, so no path crosses ([Spec-006 §The service on a Windows computer](../../specs/006-local-ipc-and-daemon-control.md#the-service-on-a-windows-computer)). Display-only path VALUES carried inside daemon- or control-plane-owned payload data (e.g. Spec-007's `canonicalRoot` / `fsRoot` repo-and-workspace fields, which the repo-attach renderer renders verbatim so a user can verify what was attached) are data, not capabilities: the renderer may render them as text, but no bridge surface accepts a raw path string for any OS or filesystem action. A path a person types into a field (Spec-007's user-entered `RepoAttachRequest.localPath`, the path field of `Convert to project…`) travels as data for the same reason; the daemon's resolution and bind-time checks ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)) are the enforcement point, never the renderer. On another device, `Open folder…` lists the machine's folders in place through `repo.folderList`, each entry carrying its path, and `repo.attach` takes the path of the folder the device was shown; the platform's own chooser stays on the machine itself.

> **Parameterized daemon subscriptions, and how one ends.** `daemon.subscribe` carries each subscription's request as its second argument, typed per event by the daemon method map. The transcript stream is the concrete case: `session.subscribe`, the session's one stream, takes the session's id and `afterCursor`, the last position the window kept, and the daemon validates that request before it catches up and then follows; the run streams (`run.subscribeState`, and `run.subscribeQueue`, which also takes a child's handle for that child's own queue) carry their session's id in the same way. A subscription can end while the page holds it: the daemon completes or refuses it, or main's link to the service fails under it. Main tells the page once through `onEnded`, and nothing follows on that subscription. The window opens it again from the last cursor it kept, so the daemon catches it up and nothing is lost or shown twice, and nothing is drawn for it: `Connection lost` comes only from the `daemon.status` topic, when the service itself cannot be reached.
