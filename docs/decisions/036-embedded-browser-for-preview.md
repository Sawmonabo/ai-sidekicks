# ADR-036: Embedded Browser For Preview

| Field         | Value                          |
| ------------- | ------------------------------ |
| **Status**    | `accepted`                     |
| **Type**      | `Type 2 (one-way door)`        |
| **Domain**    | Desktop App, Browser Subsystem |
| **Date**      | 2026-09-21                     |
| **Author(s)** | Claude (AI-assisted)           |
| **Reviewers** | Sawmon Abo                     |

---

## Context

The session screen has a Preview pane: a browser beside the conversation, showing the page an agent is building. Three parties use that page. The person looks at it and marks it. The agent drives it through browser tools. A workflow's browser steps and the daemon's own reads use it too. The console also runs where no desktop window is open, and from other devices through Remote Control.

A native browser view hosted beside the renderer and answering an agent's tool calls is a one-way architectural door. The case for building the browser tools by hand on Electron's in-process debugger, and avoiding the published browser-automation tool servers, rests on three objections: they pin alpha builds, they expose the whole application's debug surface, and they do not support Electron.

The versions this record was checked against: `electron` 44.1.0, `playwright-core` 1.62.1, `@modelcontextprotocol/sdk` 1.30.0. The published `@playwright/mcp` 0.0.80 was read and found to be a seven-file shim over `playwright-core`'s own server, so it is not a dependency.

## Problem Statement

What hosts the Preview page, what do an agent's browser tools attach to, and how do the tools and the live picture reach that page without a debug port any program on the machine could use?

### Trigger

The console design has Preview in it, and wiring the `browser` pane kind fixes how the page is hosted and how the agent's tools reach it.

---

## Decision

**One browser per machine, no debug port, one tool path.**

1. **On the machine that runs the session, the page is a real page.** It is a native `WebContentsView` in its own persistent partition (`persist:preview`), hosted by a `BaseWindow`. Every console window is a `BaseWindow` that hosts the renderer and every page as `WebContentsView`s, a side pane's own window included, and none is ever a `BrowserWindow`. The renderer publishes the rectangle of the pane that shows a session's page, and main positions the view over it on every frame the pane moves. When a console window reloads or crashes, main hides every page view in it until a fresh rectangle arrives, so a dead window never leaves a page painted. A page whose pane moves into a window of its own moves whole, with no reload: the same page, its debugger link, the agent's session and the live picture carry on.
2. **Where no desktop is open, the daemon's headless Chromium stands in.** Playwright starts one persistent browser context over its own launch pipe, with no port, on an installed Chrome or Edge when one is present and otherwise on Playwright's own Chromium, fetched once on first need. It is one browser with a context per session, each created with `acceptDownloads: false`, closed after ten idle minutes. Its profile folder is always the application's own, never the person's own browser profile. A branded launch that an enterprise policy blocks falls through to Playwright's Chromium. On a Linux machine, or inside a WSL 2 distribution, where Chromium cannot start because system libraries are missing, the service's `browser.chromiumRead` answers `cannotStart {reason: missingSystemLibraries, installStep}`, `installStep` being Playwright's own install step for the version the service carries, and Preview says so and shows that step as text, never running it, because it needs an administrator: `Preview's browser cannot start on <machine>: it needs system libraries that are not installed. Install them with: sudo npx playwright@1.62.1 install-deps chromium`.
3. **Another device gets a live picture only, produced by the service on whichever host runs the page.** The service opens a debugger session of its own on the page, over the relay on the desktop, and streams its screencast. It turns focus emulation on for every page it serves while an agent's session is attached, because a page out of sight (minimized, hidden, fully covered by any window, or shown while the display sleeps behind the lock screen) gives no frames and takes no click until it is; a partly covered page keeps both. Wheel, touches and keys come back as stable input commands, touches as touch events and never as mouse events, and every frame is acknowledged. The pane names the machine the page runs on. It streams only while that device has the pane open, and it is never presented as a local page.
4. **No debug port on either host.** Any program on the machine can reach a debug port and, through it, drive the console's own window and read Preview's cookies, so none is opened. On the desktop, main attaches Electron's in-process debugger (`webContents.debugger`) to each Preview view and to no other web contents, and carries its traffic on the connection the app dials to the service: `preview.pageTargetReport {pageId, targetId}` for each view, `preview.pageDebuggerSend {pageId, message}` for the service's commands, and `preview.pageDebuggerReport {pageId, message}` for the replies and events. The daemon's relay joins those views into one browser whose target list is exactly the Preview pages, the console absent, and Playwright connects to it with `connectOverCDP(transport)`. The relay is built against the feature set of VS Code's relay, which does the same for VS Code's integrated browser on Electron: separate browser contexts, frames and workers as targets, window bounds on page sessions, tab open and close bridged to main's page host so a tab the agent opens becomes a Preview page, and one message handed to Playwright per task. **The relay's page-session filter is a hard requirement:** on a page's session only `Target.setAutoAttach`, detaching that session's own children and `Target.getTargetInfo` for its own target pass, and every other `Target.*` and `Browser.*` command is refused, because a page's debugger reaches every target in the app and without the filter a Preview page's session could list the console's own interface, attach to it and read its script. No side pane's own window is ever in the target list. On the headless host Playwright drives the browser it launched over its own pipe. One resolver in the daemon returns a session's Playwright browser context, over the relay while a desktop is open and the headless browser's otherwise, and nothing downstream knows which host is live. The agent's tools, a workflow's browser steps, the live picture and the daemon's own reads all go through that one path.
5. **The agent's browser tools are Playwright's tool server, hosted inside the daemon.** The daemon calls `tools.createConnection` from `playwright-core`'s `lib/coreBundle` export once per session, the function the published `@playwright/mcp` package re-exports and which the repository's stable `playwright-core` already carries, so the tree holds no `@playwright/mcp` package and no pre-release Playwright. It hands that connection its own session's browser context from the resolver, and serves it on its own loopback HTTP route through the SDK's streamable HTTP transport in stateful session mode, a session id minted per connection, because the stateless mode refuses the client's initialized notification; the route refuses any request carrying an `Origin` header and any other path. The server is never a child process on standard input and output, and it never owns or launches a browser. It is registered with Claude Code and with Codex when the session starts, as part of the session's one tool-server entry for the daemon's tools, under the session's permission level like every other tool. `browser_run_code_unsafe` is never in that entry's tool list, although it is in the server's default set, because it runs any code in the daemon's own process, outside the provider's sandbox and outside the command approvals. The Browser settings switch `Browser tools for sidekicks` decides whether the browser tools are in the entry at all; off leaves them out, and the entry stays for the daemon's other tools.
6. **The tool route admits only the provider process the daemon started for that session.** The route's path carries a random secret minted per session and handed only to that provider in its own configuration; a request must come from loopback; a request carrying an `Origin` header is refused; and the body must declare JSON. The checks run before any method is dispatched.
7. **Everything a client sets on a page has one owner.** Every service connection passes `noDefaults: true`, so no connection pins a page's color scheme, reduced motion or focus by attaching, and focus emulation is the service's. The agent's page size is main's on the desktop: the relay hands main each `Emulation.setDeviceMetricsOverride` from a page session, and main keeps the asked width and height and sends the override back fitted into the pane (`dontSetVisibleSize: true`, a `scale` that fits the pane's rectangle, the asked `deviceScaleFactor` kept), refits it whenever the pane's rectangle changes, and scales the points of the mouse, touch and tap input page sessions send while it holds the size, so the page lays out to exactly the asked size and a click lands where it aimed. The relay refuses `Emulation.setVisibleSize` on every page session, because on a page whose renderer has crashed it takes down the whole app, and refuses the scroll and pinch gesture commands while a size is held; main never calls `webContents.enableDeviceEmulation`. On the headless host the override stands as sent. Only the agent intercepts a page's requests or changes its network conditions, through its session's one tool connection; the service's own sessions, the daemon's reads and a workflow's browser steps never do.
8. **One saved site-data set per machine** is shared by the pane, the tools and workflow steps. Electron's persistent partition owns it. A site's `Forget` and `Clear cookies` go per registrable domain through `ses.clearData`, which main answers for the service (`preview.pageSiteDataClear {origins?}` and `preview.pageCookiesClear`), because a per-origin clear leaves a login cookie set on the parent domain; on the headless host the service clears in its own browser context. On the machine's own desktop window, a file a page saves opens the system save dialog: the Preview feature asks for it through the platform bridge, and main owns the dialog and the file write, so the window gains no file access. On another device, on the headless host and anywhere no person at that machine can choose, the download is refused: main cancels it with `event.preventDefault()` in its `will-download` handler, and every headless context is created with `acceptDownloads: false`; the refusal comes back to the pane as one line. A login crosses between the two hosts as cookies, on hand-over, never continuously.
9. **Preview opens no listening port on either host, with one exception.** On a Windows computer whose background service runs inside a WSL 2 distribution ([ADR-041](041-the-service-on-wsl-2.md)), the debugger link rides the Windows named pipe the app already dials, and Preview loads a dev server's port wherever WSL itself carries it to Windows. Whether it does is checked per WSL networking mode, so another program's page on that port is never shown: in NAT mode the Windows loopback port must be held by WSL's own relay, and in mirrored mode a Linux bind to a port a Windows program holds fails, which is the check. Where WSL cannot carry the port, the service's Windows half carries it on a Windows loopback port of its own, bound to this machine only and reachable by any program on it, the dev server's own number when it is free and otherwise the next free one. `preview.pageOpen` and `preview.navigate` answer the address Preview loads, with `movedFrom: port` when the carry took the next free port, which Preview's address field says: `127.0.0.1:5174 (5173 was in use)`. That carry is the one exception to "no listening port". A shared port, which the person lists on Settings › Devices so their other devices can open a dev server as if it ran on them ([Spec-028](../specs/028-remote-control.md)), is a separate forward over the Remote Control channel, only to listed ports and only to loopback, and never a Preview listener.
10. **The caps.** One browser per machine, one tool server per daemon, one renderer process per open page, and nothing else per session. Pages are bounded by the machine's memory rather than by a count: when main's available memory falls below a fifth of physical memory, and at least 1 GiB, the oldest page nobody is looking at is released with its address kept, one every 1.5 s, never the page on screen; a page unseen for ten minutes is released and reloads on demand.

### Thesis — Why This Option

- **A real page, because a picture of one is not a browser.** Input, focus, accessibility, selection, scrolling and media all behave as the platform's browser does only when the page is a native view taking real operating-system input.
- **`BaseWindow`, because `BrowserWindow` breaks the attach.** A `BrowserWindow` owns a web contents of its own that never navigates. It appears in the debug target list as a silent page, Playwright attaches to it automatically and then waits forever: measured on Electron 44.1.0, `connectOverCDP` against a `BrowserWindow` timed out at 30 seconds, and against a `BaseWindow` completed in 36 to 37 milliseconds with one fewer process.
- **Two clients can drive one page.** Measured on the same build: the in-process debugger and a second client attach at once, in either order, without error; click counts are exact with none lost or doubled; each sees the other's changes; and the in-process debugger emits no detach event. Through the relay, Playwright, the tool server and a worker ran together with no error replies. So the screencast and the tools share a page without either reserving it. What a client sets on a page is shared by every client on it: a Playwright client connected without `noDefaults` pins the color scheme, reduced motion and forced colors for as long as it is attached. So each setting has one owner: focus emulation is the service's, the agent's size is main's, and interception is the agent's alone.
- **A maintained tool server, because a home-made one must be maintained forever.** Playwright's server brings its full tool set, 78 tools on the 1.62.1 pin, an accessibility snapshot with element references, and one element-reference vocabulary shared by the marks layer, the agent's own snapshot and a workflow's browser steps. The element reference it gives the agent is the same reference a person's mark carries, so "this button" is exact in both directions.
- **One resolver keeps the agent ignorant of the host.** The desktop, the headless fallback and the workflow runner differ only in which browser context the resolver returns.

### Antithesis — The Strongest Case Against [T2]

The three objections are not idle.

1. **The alpha pin.** `@playwright/mcp` 0.0.80 depends on a `1.63.0-alpha` Playwright pair, ahead of the repository's 1.62.1, and every one of its published versions pins a pre-release pair. A shipped desktop application would carry an alpha dependency in a privileged process.
2. **Electron is not supported.** The published server expects to launch or own a browser, and Electron is not a target it supports.
3. **Whole-application debug exposure.** Playwright's server attaches over the Chrome debug protocol, and the usual way to expose that protocol from Electron is the application-wide `remote-debugging-port` switch: a plain loopback port with no authentication. Chromium refuses a debug connection that carries a web `Origin` header unless that origin was allowed at launch, which stops a web page from reaching it, but a local process sends no `Origin` and is let in. Any process running on the machine, under any local user, could list the application's targets, including the console's own renderer, drive them and read Preview's cookies. The hand-built alternative, tool handlers on the in-process debugger, opens no port at all.

A skeptical reviewer would add that a two-host design doubles the test surface, and that a tool server with 78 tools is a wide grant to a model.

### Synthesis — Why It Still Holds [T2]

1. **The alpha pin is answered by not taking the package.** `@playwright/mcp` is a seven-file shim whose entry re-exports `tools.createConnection` from `playwright-core/lib/coreBundle`, a declared subpath export of the stable `playwright-core` already in the tree; the server and its tools live in that bundle. The daemon calls the export directly, so no pre-release enters the tree and there is exactly one element-reference implementation. The export and the element-reference format are re-checked on every `playwright-core` bump, and a bump that fails the check does not land; should the export ever leave the package, the fallback is the shim held to the stable pair by a pnpm override. The server is used through one entry point, which narrows what a change can break.
2. **Electron support is not needed, because the server never owns or launches a browser.** Each connection is handed its own session's browser context from the resolver and acts on a browser the machine already has. The package's own warning that a persistent profile can serve only one browser instance does not bind, for the same reason. Isolation between sessions comes from the context each connection is given, not from the server.
3. **The debug exposure is answered by opening no debug port on either host.** On the desktop, main attaches Electron's in-process debugger to each Preview view and to nothing else, carries its traffic on the connection the app already dials to the service, and the daemon's relay joins the views into one browser that Playwright connects to over a transport rather than a socket. The relay's page-session filter, a hard requirement, refuses every `Target.*` and `Browser.*` command a page session sends beyond the ones it needs, so a page's debugger, which reaches every target in the app, cannot list or attach to the console's own interface. The headless host is driven over Playwright's own launch pipe. So no program on the machine has a debug port to reach, and the console's own window is never in a target list. Measured through the relay on Electron 44.1.0 with `playwright-core` 1.62.1: a first connect in 21 to 23 milliseconds, a page usable in 25 to 28, the screencast at 60 to 97 frames a second, and clicks, typing, page snapshots and new and closed tabs all working. `--remote-debugging-pipe` is not among Electron's documented switches and is not built on. The project maintains the relay.

The two hosts share every layer above the resolver, so the second host adds tests for start, hand-over and idle close, not a second copy of the tool tests. The tool grant is governed like every tool: the session's permission level applies to each call, and one switch in Settings, `Browser tools for sidekicks`, decides whether any of them is registered at all.

---

## Alternatives Considered

### Option A: Native view, the relay with no debug port, Playwright's tool server in the daemon (Chosen)

- **What:** As decided above.
- **Steel man:** A real page for the person, a maintained and familiar tool set for the agent, and one path for every consumer on every host.
- **Weaknesses:** A relay that the project maintains, experimental debug-protocol fields (the fitted size's `scale` and `dontSetVisibleSize`, the screencast and focus-emulation commands) re-probed on every Electron bump before the pin moves, and a `playwright-core` export and element-reference format re-checked on every Playwright bump.

### Option B: Tool handlers built by hand on Electron's in-process debugger (Rejected)

- **What:** Own tool handlers typed with `devtools-protocol` on Electron's in-process debugger, served through the callback-tool host.
- **Steel man:** No relay, no Playwright dependency, no new server, nothing in the daemon.
- **Why rejected:** It works only where the desktop is open, so the headless case and workflow steps would need a second implementation. Every tool, the accessibility snapshot and the element-reference scheme would be written and maintained here, against a protocol that changes with every Chromium. It also cannot give marks and tools one reference vocabulary without building that vocabulary too.

### Option C: The published tool server as a child process with its own browser (Rejected)

- **What:** Run the server the way its documentation shows: a child on standard input and output that launches a browser.
- **Steel man:** Exactly the supported configuration.
- **Why rejected:** The agent would drive a different browser from the one the person is looking at, with different cookies, which defeats the pane. It adds a process and a Chromium per session.

### Option D: A streamed picture of a headless page on every machine (Rejected)

- **What:** Always run the page headless in the daemon and show a screencast in the pane.
- **Steel man:** One host, one code path, identical on every device.
- **Why rejected:** On the machine that runs the session, a picture cannot take real input, focus, selection, accessibility or media. A picture is kept only for other devices, where no real page can exist.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Playwright reaches the desktop's Preview pages through the relay over Electron's in-process debugger, and a `BaseWindow` keeps a mute page target out of every target list | Measured on Electron 44.1.0 with `playwright-core` 1.62.1: through the relay a first connect in 21 to 23 ms and a page usable in 25 to 28 ms, the screencast at 60 to 97 frames a second, and clicks, typing, snapshots and new and closed tabs working; a `BrowserWindow`'s own web contents made an attach time out at 30 s where a `BaseWindow` completed in 36 to 37 ms | The desktop host would need hand-built tool handlers on the in-process debugger, and Option B's costs return |
| 2 | Two debug clients can drive one page safely | Measured on the same build, both attachment orders, exact click counts, no detach events. It is not documented as safe anywhere | The screencast and the tools would need to take turns on a page |
| 3 | `createConnection` can be bound to a transport the daemon builds and handed an existing browser context | It is the package's exported programmatic entry; the daemon depends on `@modelcontextprotocol/sdk` directly for the transport. Measured on 1.62.1 with SDK 1.30.0: an in-memory handshake lists the 24 default tools in 11 ms, a loopback HTTP handshake completes in 39 ms, `browser_snapshot` mints element references and `browser_click` lands on one, and the server launches no browser | The server would have to run as a child process, and Option C's objections return |
| 4 | Element references are stable within one snapshot | `playwright-core` registers an `aria-ref` selector engine that resolves them. Stability across snapshots is undocumented | A mark's reference is treated as valid only for the snapshot that minted it, which the design already does |
| 5 | The relay's page-session filter keeps a Preview page's session from reaching the console's own interface | A page's in-process debugger reaches every target in the app; the relay passes only `Target.setAutoAttach`, the detach of the session's own children and `Target.getTargetInfo` for its own target, refuses every other `Target.*` and `Browser.*` command on a page session, and answers the rest from its own target list, which holds only Preview pages | A Preview page could list the console's interface, attach to it and read its script; the relay does not ship without the filter |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A Preview page's debugger session reaches the console's own interface | Low | High | The relay's filter tests, which send every refused `Target.*` and `Browser.*` command from a page session and expect a refusal | The page-session filter is a hard requirement; the relay's target list holds only Preview pages, and no side pane's own window is ever in it |
| A `playwright-core` bump changes the reference format or drops the `lib/coreBundle` export | High | Med | The export and reference-format check on every bump | The bump does not land until the check passes; if the export leaves the package, the shim is taken under a pnpm override that holds it to the stable pair |
| A Playwright client's emulation changes what the person sees | Med | Low | The pane's theme or motion changes when a tool attaches | Emulation state, device metrics and interception each have one owner in the daemon, so a tool's change is known and can be undone |
| Pages exhaust memory | Med | Med | The process inventory and each process's working set, read from the application's metrics | The caps: release the oldest idle page first, release unseen pages after ten minutes |
| The screencast stalls | Low | Low | Frames stop after three | Acknowledge with `Page.screencastFrameAck`; any other name stalls the queue at three frames in flight |

## Reversibility Assessment

- **Reversal cost:** Weeks. The window type, the partition, the tool registration with both providers, the mark format and the workflow browser steps all rest on it.
- **Blast radius:** The desktop main process, the daemon, [Spec-021](../specs/021-desktop-app-and-renderer.md), [Spec-015](../specs/015-workflow-authoring-and-execution.md)'s browser steps and [Spec-028](../specs/028-remote-control.md)'s live picture.
- **Migration path:** Replace the tool server behind the same registration, or replace a host behind the same resolver. The native view and the partition would stay.
- **Point of no return:** When saved site data and workflows with browser steps exist on people's machines.

## Consequences

### Positive

- The person, the agent and a nightly workflow use one page and one login.
- The agent's element references and a person's marks are one vocabulary.
- No browser-tool code to maintain beyond hosting and admission.

### Negative (accepted trade-offs)

- A relay that the project maintains, built against the feature set of VS Code's relay.
- Experimental debug-protocol fields and commands on Preview's path, each named with its reason and re-probed on every Electron bump before the pin moves, and a `playwright-core` export checked on every Playwright bump.
- A download saves only through the system save dialog on the machine's own desktop window and is refused everywhere else, a popup becomes a page, nothing typed in the address becomes a web search, and there is no developer-tools button: Preview is not a general browser.

### Unknowns

- Whether a later Chromium keeps the experimental fields the fitted size and the live picture rely on (`scale` and `dontSetVisibleSize` on the device-metrics override, the screencast commands, `Emulation.setFocusEmulationEnabled`). The resize and screencast probes run again on every Electron bump before the pin moves.
- Whether `--disable-gpu`, `--renderer-process-limit` and `--in-process-gpu` reduce the page cost. They are undocumented tuning switches and are measured before adoption.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Processes per open page beyond the page's own renderer | Zero | The application's process metrics under the Preview workload | When Preview is wired live |
| Tool calls that reach a browser other than the one in the pane | Zero | A test that marks a page and has the agent act on the mark's reference | When the tool route lands |
| Requests admitted to the tool route without the session secret, from a non-loopback peer, or with an `Origin` header | Zero | Route admission tests | When the tool route lands |
| Listening debug ports the app or the service opens | Zero | A listing of the app's and the service's listening sockets under the Preview workload | When Preview is wired live |
| Commands the relay admits from a page session beyond `Target.setAutoAttach`, its own children's detach and its own `Target.getTargetInfo` | Zero | The relay's filter tests | When the relay lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Dual-client probe on Electron 44.1.0 with `playwright-core` 1.62.1 | Primary research | `BaseWindow` attach in 36 to 37 ms against a 30 s timeout on `BrowserWindow`; two clients drive one page with exact counts; a hidden view screencasts at about 48 frames a second; one hidden `WebContentsView` costs about 247 MB of working set and three processes beyond a bare Electron main | Measured for the console design; the figures are inlined here |
| Relay probe on Electron 44.1.0 with `playwright-core` 1.62.1 | Primary research | Through the in-process debugger and a relay, `connectOverCDP(transport)` connects in 21 to 23 ms, a page is usable in 25 to 28 ms, the screencast runs at 60 to 97 frames a second with focus emulation on, and clicks, typing, snapshots and new and closed tabs work; handing Playwright a batch of messages lost an event and hung a call, so the transport hands one message per task; a page fully covered, or shown while the display sleeps behind the lock screen, gives no frames until focus emulation is on | Measured for the console design; the figures are inlined here |
| Electron `webContents.debugger` documentation | Documentation | Commands are scoped to one web contents; detach fires when the contents close or developer tools open | https://www.electronjs.org/docs/latest/api/debugger |
| ChromeDriver 111 connection thread | Community discussion | A debug WebSocket handshake carrying an `Origin` must match `--remote-allow-origins` or is refused. Chromium checks the header only when it is present, which is why a local process that sends none is admitted and a web page is not | https://groups.google.com/g/chromedriver-users/c/xL5-13_qGaA (read 2026-09-21) |
| `@playwright/mcp` package | Package source, read 2026-09-22 | Seven files; `index.js` re-exports `tools.createConnection` from `playwright-core/lib/coreBundle`; every published version pins a pre-release Playwright pair. Its warning that a persistent profile serves one browser instance at a time does not bind a server that owns no browser | https://www.npmjs.com/package/@playwright/mcp |
| `playwright-core` 1.62.1 package | Package source, read 2026-09-22 | `./lib/coreBundle` is a declared subpath export; `require` of it gives `tools.createConnection` with 78 browser tools and the `aria-ref` selector engine; the package declares no dependencies | https://registry.npmjs.org/playwright-core/1.62.1 |

### Related ADRs

- [ADR-016: Electron Desktop App](016-electron-desktop-app.md) — the framework that hosts the view.
- [ADR-024: Electron Main-Process Window Retention](024-electron-main-process-window-retention.md) — the main-process retention reference and the `BaseWindow::self_ref_` anchor it rests on; every window it holds is a `BaseWindow`.
