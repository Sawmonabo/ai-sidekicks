# Page-Host Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Page-Host Method Registry

The Preview pane and the machine-wide Browser page are served by two daemon JSON-RPC roots, `preview` and `browser`. Both register against the Plan-005 `MethodRegistry` in that plan's remainder, which owns them along with the daemon-side pieces they answer from ([Plan-005 CP-005-10](../../plans/005-local-ipc-and-daemon-control.md#cp-005-10--the-daemons-page-host-namespaces-preview-and-browser-owed-to-plan-020-cp-020-5)).

**Why the daemon and not the main process.** There are TWO page hosts and ONE endpoint: the desktop's own native page view, and — where no desktop runs — the daemon's headless browser, launched over Playwright's own pipe with no listening port and with `acceptDownloads: false`. One resolver in the daemon returns the live host and nothing above it branches, so an agent never knows which host it is talking to: the daemon reaches the desktop's pages through the relay's debugger link on the connection the app dials to the service, never a debug port, and the headless browser directly. Putting the verbs on the daemon is what makes that true; putting them on the main process would give the no-desktop case no surface at all. A file a page saves, in the Preview pane of the machine's own desktop window, opens the system save dialog: the Preview feature asks for it through the platform bridge, and the main process owns the dialog and the file write, so the window gains no file access. On another device, on the headless host, or anywhere no person at that machine can choose, the download is refused and nothing is written — on the desktop host main cancels it in `will-download` with its documented cancel, `event.preventDefault()`, and reports the refusal to the service, and the headless host is launched with downloads off — and the service sends one line back to the pane, `Downloads are off in Preview`. A file chooser a page opens from another device's press is that device's, on both hosts: the service, which intercepts choosers on its own debugger session (`Page.setInterceptFileChooserDialog`, `Page.fileChooserOpened`), on the desktop only while a device's input or an agent's browser call is in flight on the page, sends it on the device's stream, the device picks one of its own files and stages it on the machine through the attachment ingest ([Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1)), and the service sets it on the input with `DOM.setFileInputFiles`, so the page sees its `input` and `change` events; a chooser with no `backendNodeId`, which the protocol sends only for one not opened by an `<input type="file">`, is a page's `showOpenFilePicker`, `showSaveFilePicker` or `showDirectoryPicker`, which interception itself refuses with an `AbortError` ("Intercepted by Page.setInterceptFileChooserDialog()", [`global_file_system_access.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/file_system_access/global_file_system_access.cc)), so nothing waits on it and the device is sent nothing; a press at the machine itself opens the system dialog, and on the desktop the relay answers a Playwright session's `Page.setInterceptFileChooserDialog` itself, so the agent's connection never takes that dialog away ([Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/), [DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)). The renderer owns no page: it publishes the rectangle a page is positioned to and renders the outcomes, through the preload bridge's own page-host namespace — a **bridge namespace canonical in the `PlatformBridge` interface in the front end's `services/platform/`** per the api-payload-contracts.md §Source-of-Truth Policy, which shares the word `browser` with the root below and is a different surface: the bridge positions and captures a page, the root below manages pages and site data. The bridge's `daemon`, `native` and `window` namespaces are canonical in that same file and are not mirrored here; what the design fixes about them is one rule each — every address the console hands outward goes through the bridge's external-open except a loopback address printed in a reply, a tool row or a shell, which opens in the Preview pane instead; the composer's attach picker takes files only and several at a time, never a folder, and hands back tokens, never a path; and any side pane can move into its own window.

| Method | Procedure type | Request → Response | What it carries |
| --- | --- | --- | --- |
| `preview.pageList` | `subscription` | `PreviewPageListRequest` → `PreviewPageListResponse` (stream) | The session's open pages in the session's order — address, title, favicon, load state, history depth, zoom, and whether the page is released — plus the active index; read by the renderer and by the main process, which keeps one page view per page in step with it |
| `preview.pageOpen` | `mutation` | `PreviewPageOpenRequest` → `PreviewPageOpenResponse` | Opens a page from an address or from a discovered dev server; the main process also calls it with the address of a popup a page opens, so a popup becomes a page and never a window |
| `preview.pageClose` | `mutation` | `PreviewPageCloseRequest` → `PreviewPageCloseResponse` | Closes one page |
| `preview.pageActivate` | `mutation` | `PreviewPageActivateRequest` → `PreviewPageActivateResponse` | Makes one page the open one |
| `preview.pageReorder` | `mutation` | `PreviewPageReorderRequest` → `PreviewPageReorderResponse` | Moves one page to a new place in the strip; the order is the session's, so every device draws it the same |
| `preview.navigate` | `mutation` | `PreviewNavigateRequest` → `PreviewNavigateResponse` | Navigates a page; back, forward and reload ride the same verb rather than three of their own |
| `preview.zoom` | `mutation` | `PreviewZoomRequest` → `PreviewZoomResponse` | Sets a page's zoom factor on the executing machine: main's `webContents.setZoomFactor` on the desktop host, and on the headless host one `Emulation.setDeviceMetricsOverride` of the service's own, the page's size divided by the factor and its device scale times it, sent again after any browser call that resizes the page and after a debugger client detaches |
| `preview.devServerList` | `subscription` | `PreviewDevServerListRequest` → `PreviewDevServer[]` (stream) | The dev servers discovered in the session's project — name, framework where known, port. Ticks only while a project session is live |
| `preview.marksSend` | `mutation` | `PreviewMarksSendRequest` → `PreviewMarksSendResponse` | The frozen picture and its marks, staged as one attachment in the session's composer; it goes to the provider with the ordinary Send |
| `preview.screencastSubscribe` | `subscription` | `PreviewScreencastSubscribeRequest` → `PreviewScreencastElement` (stream) | The page's live picture for another device: its frames; the page's right-click menu — its point, in frame pixels, the link under the press, whether it landed in a field that takes text, whether the page allows a cut and a copy there, and the selected text, none where it allows no copy, as in a password field, sent when the page leaves a device's menu uncanceled; and a file chooser a device's press or key opened. Another device only, live only while that device has the pane open |
| `preview.screencastAck` | `mutation` | `PreviewScreencastAckRequest` → `PreviewScreencastAckResponse` | Acknowledges one frame by its `ackToken`, which the service passes to `Page.screencastFrameAck` |
| `preview.screencastInput` | `mutation` | `PreviewScreencastInputRequest` → `PreviewScreencastInputResponse` | One press, move, release, wheel, touch or key from the device, answered with the `messageId` the service gives it, which a menu or a file chooser that input raised names |
| `preview.screencastEdit` | `mutation` | `PreviewScreencastEditRequest` → `PreviewScreencastEditResponse` | The device's menu's `Paste` with its text, `Select all`, or `Cut`'s removal, naming the menu's `messageId`; refused with `preview.edit_refused`, changing nothing, where the page took other input after the menu opened |
| `preview.screencastFileChoose` | `mutation` | `PreviewScreencastFileChooseRequest` → `PreviewScreencastFileChooseResponse` | The device's answer to a file chooser its press or key opened: the files it picked from its own, each first staged on the machine through the `AttachmentIngestInit` / `AttachmentIngestChunk` / `AttachmentIngestComplete` trio and named here by its artifact id, which the service sets on the page's input, or none for a cancel |
| `browser.siteDataList` | `query` | `BrowserSiteDataListRequest` → `BrowserSiteDataListResponse` | The sites with saved data, each saying whether it holds an unexpired cookie |
| `browser.siteDataForget` | `mutation` | `BrowserSiteDataForgetRequest` → `BrowserSiteDataForgetResponse` | `Forget`: one site's full erase — cookies, storage, cache and service workers — across its registrable domain |
| `browser.siteDataClear` | `mutation` | `BrowserSiteDataClearRequest` → `BrowserSiteDataClearResponse` | Clears every site's saved data |
| `browser.siteCookiesClear` | `mutation` | `BrowserSiteCookiesClearRequest` → `BrowserSiteCookiesClearResponse` | `Clear cookies`: one site's cookies across its registrable domain, parent-domain cookies included, and nothing else |
| `browser.siteSignIn` | `mutation` | `BrowserSiteSignInRequest` → `BrowserSiteSignInResponse` | `Sign in`: opens the site in a browser page of its own that belongs to no session, over the machine's one site-data set, showing the address line and nothing else |
| `browser.chromiumRead` | `query` | `BrowserChromiumReadRequest` → `BrowserChromiumReadResponse` | Which browser the headless host uses — an installed Chrome or Edge, or Playwright's Chromium — with its version and when it was fetched |
| `browser.chromiumFetch` | `mutation` | `BrowserChromiumFetchRequest` → `BrowserChromiumFetchResponse` | `Fetch it again`: fetches Playwright's Chromium again; its progress is the fetch's own flow row |

**The main process's page host.** The desktop's pages live in the main process, so the daemon also calls the main process, and the main process reports to the daemon, on the `preview` root. These calls ride the connection the app dials to the service, which the app labels with `DaemonHello.clientId` — a label, not authentication — and never the preload bridge or a port.

| Method | Direction | Procedure type | Request → Response | What it carries |
| --- | --- | --- | --- | --- |
| `preview.pageTargetReport` | main → daemon | `mutation` | `PreviewPageTargetReportRequest` → `PreviewPageTargetReportResponse` | Each page view's debug target, so the relay joins exactly the Preview pages |
| `preview.pageDebuggerSend` | daemon → main | `mutation` | `PreviewPageDebuggerSendRequest` → `PreviewPageDebuggerSendResponse` | One debug-protocol command to a page, which main passes to that page view's in-process debugger |
| `preview.pageDebuggerReport` | main → daemon | `mutation` | `PreviewPageDebuggerReportRequest` → `PreviewPageDebuggerReportResponse` | One debug-protocol reply or event from a page view; main carries no `Page.fileChooserOpened` where a press or key at the machine reached that page while the relayed command it followed awaited its reply, so that chooser reaches no one |
| `preview.pageMenuReport` | main → daemon | `mutation` | `PreviewPageMenuReportRequest` → `PreviewPageMenuReportResponse` | The right-click menu a press main relayed raised, for which main pops no menu, and none where another press at that moment could have raised the same menu: the relayed message's id, the menu's point, its frame's address, the link under the press, whether the press landed in a field that takes text, whether the page allows a cut, a copy and select all there, and the selected text, left out where it allows no copy; the service hands it to the device whose press it was and drops it for an agent's |
| `preview.pageEdit` | daemon → main | `mutation` | `PreviewPageEditRequest` → `PreviewPageEditResponse` | A device's `Paste` with its text, `Select all`, or `Cut`'s removal from that menu, naming the menu by its message id, which main answers with `webContents.insertText(text)`, `selectAll()` or `delete()` in the frame holding focus while that menu is still the page's current one, and otherwise refuses with `preview.edit_refused`, changing nothing; the service hands that refusal back to the device as `preview.screencastEdit`'s |
| `preview.pageCookiesRead` | daemon → main | `query` | `PreviewPageCookiesReadRequest` → `PreviewPageCookiesReadResponse` | The desktop host's cookies, in Playwright's storage-state cookie shape, when the headless host takes over |
| `preview.pageCookiesWrite` | daemon → main | `mutation` | `PreviewPageCookiesWriteRequest` → `PreviewPageCookiesWriteResponse` | Cookies written into the desktop host when it takes over, `expires` mapped to Electron's `expirationDate` |
| `preview.pageCookiesClear` | daemon → main | `mutation` | `PreviewPageCookiesClearRequest` → `PreviewPageCookiesClearResponse` | One site's cookies cleared across its registrable domain, answered with Electron's `ses.clearData` given `dataTypes: ['cookies']`, the one call that removes a parent-domain cookie |
| `preview.pageSiteDataClear` | daemon → main | `mutation` | `PreviewPageSiteDataClearRequest` → `PreviewPageSiteDataClearResponse` | One site's saved data or, with no origins, every site's, answered with `ses.clearData({origins, dataTypes})` for named sites and `ses.clearData()` for all |

The main process attaches Electron's in-process debugger to each Preview page view and to no other `webContents`. The relay joins those pages into one browser whose target list is exactly the Preview pages, the console's own windows absent; on a page's session it passes only `Target.setAutoAttach`, the detach of that page's own children and `Target.getTargetInfo` for its own target, and refuses every other `Target.*` and `Browser.*` command, because a page's debugger reaches every target in the app. On the headless host the daemon does the same work in its own browser context: `context.clearCookies({domain})` for `Clear cookies`, and that plus the site's storage for `Forget`. Moving site data between the two hosts happens only when one takes over from the other: cookies through the cookie calls, local storage and IndexedDB copied by script, and passkeys never crossing, which the pane says rather than silently dropping a login.

**The agent's browser tools are not session verbs.** They are tools of the daemon's shared `sidekicks` tool server, attached to the calling session's debug endpoint and reached by the provider through that session's one entry for the server. The renderer learns about them the way it learns about any tool call — as rows in the transcript — so no verb above dispatches one. `Browser tools for sidekicks`, a switch in the machine's settings file, decides whether the browser tools are in that entry's tool list: off leaves only them out, and the entry stays for the daemon's other tools. `Remember site data`, the other browser switch, is the settings file's too; neither is a verb. Off follows Chrome's model: the set in use keeps working while the browser is open and is erased when it closes, so a login does not survive a restart — on the desktop a partition without `persist:`, which Electron keeps in memory ([Electron: session.fromPartition](https://github.com/electron/electron/blob/main/docs/api/session.md)), and on the headless host Playwright's temporary profile, `userDataDir: ''` ([Playwright: launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)), the saved set erased at that close; the headless browser closes after ten idle minutes, so a login there can end then.

```ts
// One open page in a session's Preview pane. The id is the daemon's; no client mints one.
interface PreviewPage {
  pageId: string;
  address: string;
  title: string; // the host until the page's own title arrives
  favicon?: string;
  loadState: "loading" | "loaded" | "failed";
  // The history depth behind and ahead of where the page stands — what the back and forward controls
  // read to decide whether they can act. They are the one pair of controls the console grays in place
  // rather than hiding, because the person changes their subject by following a link.
  backDepth: number;
  forwardDepth: number;
  zoomFactor: number; // 1 when a page opens
  // A released page keeps its address, order and zoom and reloads when shown; the main process destroys
  // its page view. A page nobody has looked at for ten minutes is released, and when the machine's memory
  // falls below the workflow memory gate's headroom — 20% of physical memory, and at least 1 GiB — the
  // oldest page nobody is looking at is released first, one every 1.5 s until the reading is back above
  // it, never the page on screen.
  released: boolean;
}
interface PreviewPageListRequest {
  sessionId: SessionId;
}
// One emission of the stream: the first is the current state, then one per change. The daemon keeps each
// session's pages — address, order, which is active, zoom — in its own per-session page store: a service
// restart reconnects the page views the app still holds without reloading them, and headless pages, and
// every page after an app restart, come back released.
interface PreviewPageListResponse {
  pages: PreviewPage[]; // in the session's order
  // The page the pane is showing. -1 where the session has no page open, so an empty pane is
  // representable without an optional member that a reader could mistake for "unknown".
  activeIndex: number;
}

// Opening is EITHER an address the person entered or a server the daemon discovered — a closed union,
// so a caller cannot ask for both and leave the daemon to choose. An entry the pane will not take is
// refused by NAMING THE CAUSE and the page stays where it was: text that is not an address is refused
// as not-an-address rather than searched, and a scheme the pane cannot open says so. An address carrying
// a username or a password opens as typed. Nothing is ever searched on the web.
type PreviewPageTarget = { kind: "address"; address: string } | { kind: "devServer"; port: number };
interface PreviewPageOpenRequest {
  sessionId: SessionId;
  target: PreviewPageTarget;
}
interface PreviewPageOpenResponse {
  pageId: string;
  // The page the ceiling released to make room, where one was released. Its address is kept and it
  // reloads on demand, so this is a fact the pane may report and never a refusal.
  releasedPageId?: string;
}

interface PreviewPageCloseRequest {
  sessionId: SessionId;
  pageId: string;
}
interface PreviewPageCloseResponse {
  closed: true;
}

interface PreviewPageActivateRequest {
  sessionId: SessionId;
  pageId: string;
}
interface PreviewPageActivateResponse {
  activePageId: string;
}

// The order is the session's, so every device draws the same strip.
interface PreviewPageReorderRequest {
  sessionId: SessionId;
  pageId: string;
  toIndex: number; // the place in the list without that page
}
interface PreviewPageReorderResponse {
  pageIds: string[]; // the session's new order
}

// One verb for five acts, because all five move the same page's position in its own history.
interface PreviewNavigateRequest {
  sessionId: SessionId;
  pageId: string;
  to:
    | { kind: "address"; address: string }
    | { kind: "back" }
    | { kind: "forward" }
    | { kind: "reload" };
}
interface PreviewNavigateResponse {
  pageId: string;
  address: string;
  backDepth: number;
  forwardDepth: number;
}

interface PreviewZoomRequest {
  sessionId: SessionId;
  pageId: string;
  zoomFactor: number;
}
interface PreviewZoomResponse {
  pageId: string;
  zoomFactor: number;
}

// Discovery is the DAEMON'S, never the renderer's: one probe loop per daemon, enumerating the
// machine's listening sockets, keeping the dev servers in the session's project, ones this session
// did not start included, and probing each briefly. `startedHere` is read from the session's own
// process tree, so a server another session left running carries no mark. `name` and `framework`
// are `null` where the daemon could not tell, so the row reads the port alone; `null` means the
// server did not say rather than that it has none.
interface PreviewDevServerListRequest {
  sessionId: SessionId;
}
interface PreviewDevServer {
  port: number;
  name: string | null;
  framework: string | null;
  startedHere: boolean; // this session started the server, by its agent or in its own shell
}

// A mark drawn on the frozen picture. Three kinds: a numbered comment, a numbered box, and a pen stroke,
// which is never numbered — which is why removing a comment renumbers the comments and boxes and leaves
// strokes alone. Every mark carries the element reference and bounding box taken from the page snapshot
// AT MARK-COMMIT TIME, so a mark drawn on another device's live picture reaches the agent as the same
// attachment as one drawn on the machine that runs the session. A reference is valid ONLY for the
// snapshot generation that minted it, which is why the generation rides with it and is never assumed to
// survive the next snapshot.
interface PreviewMark {
  kind: "comment" | "box" | "stroke";
  // Present on a comment and a box, absent on a stroke.
  number?: number;
  // The person's words, on a comment.
  text?: string;
  // Page coordinates in viewport CSS pixels. A stroke carries its points; a comment and a box carry
  // their rectangle.
  rect?: { x: number; y: number; width: number; height: number };
  points?: Array<{ x: number; y: number }>;
  // A stroke's color, taken from the hue slider when it was drawn; comments and boxes take the accent.
  color?: string;
  // The element the mark landed on, resolved by the daemon from the snapshot rather than by mutating
  // the page or asking it a second time. Absent where the mark hit no element.
  elementRef?: string;
  snapshotGeneration: number;
}
// `Send marks` stages ONE attachment in the session's composer — the picture with the marks plus, per
// mark, its number, note, element reference and box (a stroke: its points and color), the page's address
// and its width — and focuses the draft. The attachment goes to the provider with the ordinary Send, in
// that provider's own image shape, and shows in the transcript as the user turn's picture.
interface PreviewMarksSendRequest {
  sessionId: SessionId;
  pageId: string;
  // The frozen picture the marks were drawn on — the page capture on the machine, the screencast frame on
  // another device — carried as base64. It is never captured again at send, which would not match the
  // marks.
  image: string;
  address: string;
  width: number; // the page's width in CSS pixels when it was frozen
  // The marks that exist NOW, not the set at the moment the send control was pressed, so an attachment
  // whose last mark was removed sends nothing and goes away instead.
  marks: PreviewMark[];
}
interface PreviewMarksSendResponse {
  staged: SessionAttachmentSummary; // the composer's attachment chip, `<N> marks on <path>`
}

interface PreviewScreencastSubscribeRequest {
  sessionId: SessionId;
  pageId: string;
}
// Each frame carries what maps its pixels back to page coordinates, which is what lets a mark drawn on
// the picture carry the same element reference as one drawn on the page. Every frame is acknowledged:
// an unacknowledged stream stalls after a small fixed number of frames in flight, so acknowledgment is
// part of the contract rather than an optimization. A subscription runs one way, so the
// acknowledgments, the input, the menu's edits and the answer to a file chooser come back as the four
// methods below it: another device's touches reach the page as touch events with touch emulation left
// off, a pinch zooms only the picture on the device, and typed keys reach the page as key input.
interface PreviewScreencastFrame {
  pageId: string;
  imageData: string;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };
  // The token the subscriber returns to acknowledge this frame.
  ackToken: string;
}
// One element of the stream. A menu and a file chooser name the `messageId` of the device's input that
// raised them, so the device knows which of its presses each answers.
type PreviewScreencastElement =
  | ({ kind: "frame" } & PreviewScreencastFrame)
  | {
      kind: "menu";
      pageId: string;
      messageId: string;
      point: { x: number; y: number }; // frame pixels
      linkUrl?: string;
      isEditable: boolean; // a field that takes text, neither read-only nor disabled
      canCut: boolean;
      canCopy: boolean;
      selectionText?: string; // absent where the page allows no copy, as in a password field
    }
  | {
      // A file chooser a device's press or key opened; the device opens its own picker.
      kind: "fileChooser";
      pageId: string;
      messageId: string;
      mode: "selectSingle" | "selectMultiple";
      accept?: string; // the input's own `accept`, which the device's picker honors
    };

interface PreviewScreencastAckRequest {
  sessionId: SessionId;
  pageId: string;
  ackToken: string;
}
interface PreviewScreencastAckResponse {}

// Points are frame pixels; the service maps them to page points from the frame's metadata, the size
// held and the page's zoom factor.
type PreviewScreencastInput =
  | {
      kind: "mouse";
      type: "press" | "move" | "release";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      clickCount: number;
      modifiers: number; // Alt 1, Ctrl 2, Meta 4, Shift 8
    }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      kind: "touch";
      type: "start" | "move" | "end" | "cancel";
      points: Array<{ x: number; y: number; id: number }>;
    }
  | {
      kind: "key";
      type: "down" | "up";
      key: string;
      code: string;
      text?: string;
      modifiers: number;
    };
interface PreviewScreencastInputRequest {
  sessionId: SessionId;
  pageId: string;
  input: PreviewScreencastInput;
}
interface PreviewScreencastInputResponse {
  messageId: string;
}

// Refused with `preview.edit_refused` where the page took other input after the menu opened; the pane
// reads `The page changed before that could run.`
interface PreviewScreencastEditRequest {
  sessionId: SessionId;
  pageId: string;
  messageId: string; // the menu's
  edit: { kind: "paste"; text: string } | { kind: "selectAll" } | { kind: "cut" };
}
interface PreviewScreencastEditResponse {
  applied: true;
}

// The files come from the device's own picker. Each is staged on the machine first through the
// AttachmentIngest trio, so its bounds and refusals (`artifact.too_large`,
// `artifact.ingest_capacity_exhausted`) apply and no request holds a whole file; the staged artifacts
// are the session's and go with it. The page reads a file's name from its path, so the service copies
// each into a folder of its own outside every checkout under the name the ingest recorded, and deletes
// the copies when the page loads another document or closes, or the session ends. An empty list is a
// cancel, which sets no file. More than one only for a `selectMultiple` chooser.
interface PreviewScreencastFileChooseRequest {
  sessionId: SessionId;
  pageId: string;
  messageId: string; // the chooser's
  artifactIds: ArtifactId[]; // each from its AttachmentIngestComplete
}
interface PreviewScreencastFileChooseResponse {
  set: number; // how many files the input now holds
}

// Site data is ONE set per machine, shared by every page, the tools and workflow steps, with per-site
// forgetting — not a partition per session. Rows are keyed per registrable domain; `origin`
// (`scheme://host:port`) names the site, and a clear or a forget covers its whole registrable domain,
// because a per-origin clear leaves a parent-domain cookie behind.
interface BrowserSiteDataListRequest {}
interface BrowserSiteDataListResponse {
  // `hasCookies` is true while the site holds at least one unexpired cookie (the row reads `Saved cookies`
  // and carries `Clear cookies`) and false while it holds other saved data and no cookie (`Saved site
  // data`, carrying `Sign in`). No member says whether the person is signed in, because a saved cookie
  // proves neither.
  sites: Array<{ origin: string; sizeBytes: number; lastUsedAt: string; hasCookies: boolean }>;
}
interface BrowserSiteDataForgetRequest {
  origin: string;
}
interface BrowserSiteDataForgetResponse {
  origin: string;
  forgotten: true;
}
interface BrowserSiteDataClearRequest {}
interface BrowserSiteDataClearResponse {
  cleared: true;
}
// Clears the site's cookies and nothing else — its storage, cache and service workers stay — and claims
// nothing about whether the person is signed out.
interface BrowserSiteCookiesClearRequest {
  origin: string;
}
interface BrowserSiteCookiesClearResponse {
  origin: string;
  cleared: true;
}
// When the sign-in page closes, the Browser page reads `browser.siteDataList` again.
interface BrowserSiteSignInRequest {
  origin: string;
}
interface BrowserSiteSignInResponse {
  origin: string;
}
interface BrowserChromiumReadRequest {}
interface BrowserChromiumReadResponse {
  source: "chrome" | "edge" | "playwright";
  version: string;
  fetchedAt?: string; // present for Playwright's Chromium
}
interface BrowserChromiumFetchRequest {}
interface BrowserChromiumFetchResponse {
  started: true; // a fetch already running is joined, not repeated
}

// The main process's page-host leg (the second table above).
interface PreviewPageTargetReportRequest {
  pageId: string;
  targetId: string;
}
interface PreviewPageTargetReportResponse {}
// One debug-protocol message, carried verbatim: a command on the send, a reply or an event on the report.
// The one event main holds back is a `Page.fileChooserOpened` a press at the machine may have raised.
interface PreviewPageDebuggerSendRequest {
  pageId: string;
  message: string;
}
interface PreviewPageDebuggerSendResponse {}
interface PreviewPageDebuggerReportRequest {
  pageId: string;
  message: string;
}
interface PreviewPageDebuggerReportResponse {}
// The menu a press main relayed raised, named by that relayed message's id; main sends none where
// another press at that moment could have raised the same menu.
interface PreviewPageMenuReportRequest {
  pageId: string;
  messageId: string;
  menu: {
    point: { x: number; y: number }; // view points, where the view's `context-menu` reports it
    frameAddress: string;
    linkUrl?: string;
    isEditable: boolean;
    canCut: boolean;
    canCopy: boolean;
    canSelectAll: boolean;
    selectionText?: string; // absent where `editFlags` allow no copy, as in a password field
  };
}
interface PreviewPageMenuReportResponse {}
// Refused with `preview.edit_refused`, changing nothing, once that menu is no longer the page's
// current one.
interface PreviewPageEditRequest {
  pageId: string;
  messageId: string; // the menu's
  edit: { kind: "paste"; text: string } | { kind: "selectAll" } | { kind: "cut" };
}
interface PreviewPageEditResponse {
  applied: true;
}
interface PreviewPageCookiesClearRequest {
  domain: string; // the site's registrable domain
}
interface PreviewPageCookiesClearResponse {
  domain: string;
}
interface PreviewPageSiteDataClearRequest {
  origins?: string[]; // absent clears every site
}
interface PreviewPageSiteDataClearResponse {
  cleared: true;
}
// `PreviewPageCookiesRead*` and `PreviewPageCookiesWrite*` carry the cookies in Playwright's
// storage-state cookie shape, `expires` mapped to Electron's `expirationDate` on write.
```
