# ADR-036: Embedded Browser For Preview

| Field         | Value                            |
| ------------- | -------------------------------- |
| **Status**    | `accepted`                       |
| **Type**      | `Type 2 (one-way door)`          |
| **Domain**    | Desktop Shell, Browser Subsystem |
| **Date**      | 2026-09-21                       |
| **Author(s)** | Claude (AI-assisted)             |
| **Reviewers** | Sawmon Abo                       |

---

## Context

The session screen has a Preview pane: a browser beside the conversation, showing the page a sidekick is building. Three parties use that page. The person looks at it and marks it. The sidekick drives it through browser tools. A workflow's browser steps and the daemon's own reads use it too. The console also runs where no desktop window is open, and from other devices through Remote Control.

[Spec-021 §ADR Triggers](../specs/021-desktop-shell-and-renderer.md#adr-triggers) requires this record before the `browser` pane kind is wired live, because a native browser view hosted beside the renderer and answering a sidekick's tool calls is a one-way architectural door. Spec-021 §Console Libraries had chosen to build the browser tools by hand on Electron's in-process debugger and to avoid the published browser-automation tool servers, for three reasons: they pin alpha builds, they expose the whole application's debug surface, and they do not support Electron.

The versions this record was checked against: `electron` 44.1.0, `playwright-core` 1.62.1, `@playwright/mcp` 0.0.80, `@modelcontextprotocol/sdk` 1.30.0.

## Problem Statement

What hosts the Preview page, what do a sidekick's browser tools attach to, and who may reach the debug endpoint that makes both possible?

### Trigger

The console design was locked on 2026-09-21 with Preview in it, and the pane cannot be wired until this record exists.

---

## Decision

**One browser per machine, one debug endpoint, one tool path.**

1. **On the machine that runs the session, the page is a real page.** It is a native `WebContentsView` in its own persistent partition (`persist:preview`), hosted by a `BaseWindow`. The console's window is a `BaseWindow` that hosts the renderer and every page as `WebContentsView`s. It is never a `BrowserWindow`.
2. **Where no desktop is open, the daemon's headless Chromium stands in.** Playwright starts one persistent browser context, on an installed Chrome or Edge when one is present and otherwise on Playwright's own Chromium, fetched once on first need. It is one browser with a context per session, closed after ten idle minutes. Its profile folder is always the application's own, never the person's own browser profile. A branded launch that an enterprise policy blocks falls through to Playwright's Chromium.
3. **Another device gets a live picture only.** The desktop's in-process debugger streams a screencast of the page, wheel and keys are forwarded, every frame is acknowledged, and the pane names the machine the page runs on. It streams only while that device has the pane open. It is never presented as a local page.
4. **Both hosts expose one Chrome-debug endpoint, and everything attaches to it.** One resolver in the daemon returns the active endpoint for a session, and nothing downstream knows which host is live. The sidekick's tools, a workflow's browser steps and the daemon's own reads all go through one Playwright-over-debug-protocol path.
5. **The sidekick's browser tools are Playwright's tool server, hosted inside the daemon.** The daemon calls `@playwright/mcp`'s `createConnection` once per session, hands that connection its own session's debug endpoint, and serves it on its own loopback HTTP route. The server is never a child process on standard input and output, and it never owns or launches a browser. It is registered with Claude Code and with Codex when the session starts, under the session's permission level like every other tool.
6. **The tool route admits only the provider process the daemon started for that session.** The route's path carries a random secret minted per session and handed only to that provider in its own configuration; a request must come from loopback; a request carrying an `Origin` header is refused; and the body must declare JSON. The checks run before any method is dispatched.
7. **One saved site-data set per machine** is shared by the pane, the tools and workflow steps. Electron's persistent partition owns it. A login crosses between the two hosts as cookies, on hand-over, never continuously.
8. **The caps.** One browser per machine, one tool server per daemon, one renderer process per open page, and nothing else per session. Pages are bounded by the machine's memory, the oldest idle page is released first with its address kept, and a page unseen for ten minutes is released and reloads on demand.

### Thesis — Why This Option

- **A real page, because a picture of one is not a browser.** Input, focus, accessibility, selection, scrolling and media all behave as the platform's browser does only when the page is a native view taking real operating-system input.
- **`BaseWindow`, because `BrowserWindow` breaks the attach.** A `BrowserWindow` owns a web contents of its own that never navigates. It appears in the debug target list as a silent page, Playwright attaches to it automatically and then waits forever: measured on Electron 44.1.0, `connectOverCDP` against a `BrowserWindow` timed out at 30 seconds, and against a `BaseWindow` completed in 36 to 37 milliseconds with one fewer process.
- **Two clients can drive one page.** Measured on the same build: the in-process debugger and an external Playwright client attach at once, in either order, without error; click counts are exact with none lost or doubled; each sees the other's changes; and the in-process debugger emits no detach event. So the screencast and the tools share a page without either reserving it. What is shared is renderer-wide emulation: a connected Playwright client pins the colour scheme, reduced motion and forced colours for as long as it is attached, so emulation state, device metrics and network interception are state the daemon owns, each with one owner.
- **A maintained tool server, because a home-made one must be maintained forever.** Playwright's server brings two dozen tools, an accessibility snapshot with element references, and one element-reference vocabulary shared by the marks layer, the sidekick's own snapshot and a workflow's browser steps. The element reference it gives the sidekick is the same reference a person's mark carries, so "this button" is exact in both directions.
- **One endpoint keeps the sidekick ignorant of the host.** The desktop, the headless fallback and the workflow runner differ only in which endpoint the resolver returns.

### Antithesis — The Strongest Case Against [T2]

Spec-021's three objections were not idle.

1. **The alpha pin.** `@playwright/mcp` 0.0.80 depends on a `1.63.0-alpha` Playwright pair, ahead of the repository's 1.62.1. A shipped desktop application would carry an alpha dependency in a privileged process.
2. **Electron is not supported.** The published server expects to launch or own a browser, and Electron is not a target it supports.
3. **Whole-application debug exposure.** The endpoint comes from the application-wide `remote-debugging-port` switch. It is a plain loopback port with no authentication. Chromium refuses a debug connection that carries a web `Origin` header unless that origin was allowed at launch, which stops a web page from reaching it, but a local process sends no `Origin` and is let in. Any process running on the machine, under any local user, can list the application's targets, including the console's own renderer, and drive them. The hand-built alternative, tool handlers on the in-process debugger, opens no port at all.

A skeptical reviewer would add that a two-host design doubles the test surface, and that a tool server with two dozen tools is a wide grant to a model.

### Synthesis — Why It Still Holds [T2]

1. **The alpha pin is answered by a rule, not dismissed.** The Playwright version pair and the element-reference format are re-checked on every bump of either package, and a bump that fails the check does not land. The server is used through one entry point, `createConnection`, which narrows what a change can break.
2. **Electron support is not needed, because the server never owns or launches a browser.** Each connection is handed its own session's debug endpoint and attaches to a browser the machine already has. The package's own warning that a persistent profile can serve only one browser instance does not bind, for the same reason. Isolation between sessions comes from the endpoint each connection is given, not from the server.
3. **The debug exposure is carried, not resolved.** This record accepts it and states it plainly: while the desktop is open with Preview available, any local process can reach the debug port on loopback. What stands against misuse is that the port is bound to loopback only; that Chromium refuses connections carrying a web origin, so no web page, including one shown in Preview, can reach it; and that a process able to run as the person on their own machine can already read their files and their provider credentials, so the port adds a convenient path and no new authority. It remains the weakest point of this design. `--remote-debugging-pipe`, which would remove the port, is not among Electron's documented switches and is not built on. Closing this exposure is the first thing to revisit when Electron documents a pipe or an authenticated endpoint.

The two hosts share every layer above the endpoint, so the second host adds tests for start, hand-over and idle close, not a second copy of the tool tests. The tool grant is governed like every tool: the session's permission level applies to each call, and one switch in Settings, `Browser tools for sidekicks`, decides whether any of them is registered at all.

---

## Alternatives Considered

### Option A: Native view, one debug endpoint, Playwright's tool server in the daemon (Chosen)

- **What:** As decided above.
- **Steel man:** A real page for the person, a maintained and familiar tool set for the sidekick, and one path for every consumer on every host.
- **Weaknesses:** An unauthenticated loopback debug port while the desktop is open, and an alpha dependency pair to watch.

### Option B: Tool handlers built by hand on Electron's in-process debugger (Rejected)

- **What:** Spec-021's previous choice: own handlers typed with `devtools-protocol`, served through the existing callback-tool host, with no port opened.
- **Steel man:** No port, no alpha dependency, no new server, nothing in the daemon.
- **Why rejected:** It works only where the desktop is open, so the headless case and workflow steps would need a second implementation. Every tool, the accessibility snapshot and the element-reference scheme would be written and maintained here, against a protocol that changes with every Chromium. It also cannot give marks and tools one reference vocabulary without building that vocabulary too.

### Option C: The published tool server as a child process with its own browser (Rejected)

- **What:** Run the server the way its documentation shows: a child on standard input and output that launches a browser.
- **Steel man:** Exactly the supported configuration.
- **Why rejected:** The sidekick would drive a different browser from the one the person is looking at, with different cookies, which defeats the pane. It adds a process and a Chromium per session.

### Option D: A streamed picture of a headless page on every machine (Rejected)

- **What:** Always run the page headless in the daemon and show a screencast in the pane.
- **Steel man:** One host, one code path, identical on every device.
- **Why rejected:** On the machine that runs the session, a picture cannot take real input, focus, selection, accessibility or media. A picture is kept only for other devices, where no real page can exist.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | An external Playwright client attaches to an Electron `BaseWindow` application over the debug port | Measured on Electron 44.1.0 with `playwright-core` 1.62.1: attach in 36 to 37 ms; 30 s timeout against a `BrowserWindow` | The tool path would fall back to the in-process debugger on the desktop host |
| 2 | Two debug clients can drive one page safely | Measured on the same build, both attachment orders, exact click counts, no detach events. It is not documented as safe anywhere | The screencast and the tools would need to take turns on a page |
| 3 | `createConnection` can be bound to a transport the daemon builds and attached to an existing endpoint | It is the package's exported programmatic entry; the daemon depends on `@modelcontextprotocol/sdk` directly for the transport | The server would have to run as a child process, and Option C's objections return |
| 4 | Element references are stable within one snapshot | `playwright-core` registers an `aria-ref` selector engine that resolves them. Stability across snapshots is undocumented | A mark's reference is treated as valid only for the snapshot that minted it, which the design already does |
| 5 | Chromium refuses debug connections that carry a web origin | Chromium requires `--remote-allow-origins` for such connections; the ChromeDriver 111 thread in the references shows the refusal | A page in Preview could reach the debug port; the port would have to go |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A local process drives the console through the debug port | Low | High | None in the application; this is the carried risk | Loopback binding and no web origins; revisit when a pipe or authenticated endpoint is documented |
| A bump of `@playwright/mcp` changes the reference format or needs a newer Playwright pair | High | Med | The version-pair and reference-format check on every bump | The bump does not land until the check passes |
| A Playwright client's emulation changes what the person sees | Med | Low | The pane's theme or motion changes when a tool attaches | Emulation state, device metrics and interception each have one owner in the daemon, so a tool's change is known and can be undone |
| Pages exhaust memory | Med | Med | The process inventory and each process's working set, read from the application's metrics | The caps: release the oldest idle page first, release unseen pages after ten minutes |
| The screencast stalls | Low | Low | Frames stop after three | Acknowledge with `Page.screencastFrameAck`; any other name stalls the queue at three frames in flight |

## Reversibility Assessment

- **Reversal cost:** Weeks. The window type, the partition, the tool registration with both providers, the mark format and the workflow browser steps all rest on it.
- **Blast radius:** The desktop main process, the daemon, [Spec-021](../specs/021-desktop-shell-and-renderer.md), [Spec-015](../specs/015-workflow-authoring-and-execution.md)'s browser steps and [Spec-028](../specs/028-remote-control.md)'s live picture.
- **Migration path:** Replace the tool server behind the same registration, or replace the endpoint behind the same resolver. The native view and the partition would stay.
- **Point of no return:** When saved site data and workflows with browser steps exist on people's machines.

## Consequences

### Positive

- The person, the sidekick and a nightly workflow use one page and one login.
- The sidekick's element references and a person's marks are one vocabulary.
- No browser-tool code to maintain beyond hosting and admission.

### Negative (accepted trade-offs)

- An unauthenticated loopback debug port exists while the desktop is open. Accepted for the reasons in Synthesis item 3, and named as the first thing to revisit.
- An alpha dependency pair that must be checked on every bump.
- Downloads are refused, a popup becomes a page, nothing typed in the address becomes a web search, and there is no developer-tools button: Preview is not a general browser.

### Unknowns

- Whether device-metrics overrides and network interception behave under two clients as emulation does. Both are unmeasured and are measured before a tool that uses them is enabled.
- Whether `--disable-gpu`, `--renderer-process-limit` and `--in-process-gpu` reduce the page cost. They are undocumented tuning switches and are measured before adoption.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [x] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Processes per open page beyond the page's own renderer | Zero | The application's process metrics under the Preview workload | When Preview is wired live |
| Tool calls that reach a browser other than the one in the pane | Zero | A test that marks a page and has the sidekick act on the mark's reference | When the tool route lands |
| Requests admitted to the tool route without the session secret, from a non-loopback peer, or with an `Origin` header | Zero | Route admission tests | When the tool route lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Dual-client probe on Electron 44.1.0 with `playwright-core` 1.62.1 | Primary research | `BaseWindow` attach in 36 to 37 ms against a 30 s timeout on `BrowserWindow`; two clients drive one page with exact counts; a hidden view screencasts at about 48 frames a second; one hidden `WebContentsView` costs about 247 MB of working set and three processes beyond a bare Electron main | Measured for the console design; the figures are inlined here |
| Electron `webContents.debugger` documentation | Documentation | Commands are scoped to one web contents; detach fires when the contents close or developer tools open | https://www.electronjs.org/docs/latest/api/debugger |
| ChromeDriver 111 connection thread | Community discussion | A debug WebSocket handshake carrying an `Origin` must match `--remote-allow-origins` or is refused. Chromium checks the header only when it is present, which is why a local process that sends none is admitted and a web page is not | https://groups.google.com/g/chromedriver-users/c/xL5-13_qGaA (read 2026-09-21) |
| `@playwright/mcp` package | Documentation | `createConnection` is the programmatic entry; a persistent profile serves one browser instance at a time, which does not bind a server that owns no browser | https://www.npmjs.com/package/@playwright/mcp |

### Related ADRs

- [ADR-016: Electron Desktop Shell](016-electron-desktop-shell.md) — the shell that hosts the view.
- [ADR-024: Electron Main-Process BrowserWindow Retention](024-electron-main-process-window-retention.md) — the main-process retention reference and the `BaseWindow::self_ref_` anchor it rests on; the window type it names becomes `BaseWindow` under this record.

## Decision Log

| Date       | Event    | Notes                            |
| ---------- | -------- | -------------------------------- |
| 2026-09-21 | Accepted | Decided with the console design. |
