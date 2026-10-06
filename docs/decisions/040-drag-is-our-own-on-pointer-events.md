# ADR-040: Drag Is Our Own, On Pointer Events

| Field         | Value                                  |
| ------------- | -------------------------------------- |
| **Status**    | `accepted`                             |
| **Type**      | `Type 1 (two-way door)`                |
| **Domain**    | Desktop Renderer, Windows, Interaction |
| **Date**      | 2026-10-05                             |
| **Author(s)** | Claude (AI-assisted)                   |
| **Reviewers** | Sawmon Abo                             |

---

## Context

The desktop app runs every window from one JavaScript realm. One hidden console document runs all of the renderer's code and opens every window a person sees with `window.open("about:blank", …)`; React renders into each window with `createPortal` ([Spec-021 §Process Model](../specs/021-desktop-app-and-renderer.md#process-model)). Two facts of that model decide how anything that moves can be built. The hidden document never paints, so its own `requestAnimationFrame` never fires: a probe counted 0 frames from it while a visible window painted 120 a second. And an observer or a listener built on the hidden document's globals hears nothing from another window's nodes: a `ResizeObserver` built there reported 0 times on a node in a visible window, while that window's own `ResizeObserver` reported twice.

Four things in the console are dragged:

1. the tabs in the terminal's strip and in Preview's strip;
2. the waiting messages stacked at the end of the transcript under a running turn;
3. the panes of a session view, each dragged by its header, which is no window drag region ([Spec-021 §The session screen](../specs/021-desktop-app-and-renderer.md#the-session-screen));
4. the session views themselves, each dragged by its title — the session's name in the view's header, whose empty space stays the window's own drag region, as a browser's empty tab strip moves its window while a tab tears off — which swap places in a window, dock into another window, and tear off onto the desktop as a window of their own.

The requirement is that a drag is smooth and has no resistance: the item sits under the pointer at every frame, its neighbors glide apart rather than jump, the drop glides into place, and a session view torn out of its window is a window that follows the pointer live, not one that appears where the drag ended. On Linux under Wayland Electron offers no way to do that, and the view's window appears at the drag's end instead (§Decision).

## Problem Statement

How should the console implement dragging, inside one window and between windows, in a realm where the page that runs the code is not the page that paints?

### Trigger

A session view holds a row of any number of panes that reorder by their headers, session views drag between windows and onto the desktop, and `@atlaskit/pragmatic-drag-and-drop`, measured in a visible window, heard no drag there.

---

## Decision

**Dragging is our own code on pointer events. No drag library is a dependency.**

- **Inside a window** — tabs, waiting messages, panes and session views: the drag starts on `pointerdown` and takes pointer capture on the element pressed. The real item lifts and follows the pointer through a `transform` written in the `pointermove` handler, so it is drawn under the pointer in the same frame. Neighbors make room with FLIP: their old and new boxes are measured once and the difference is played away with `element.animate` on each element's own document, so the glide runs on that window's own timeline and needs no frame clock. The drop glides the item into its slot the same way. Keyboard and menu reorder paths are our own as well — for panes, the Keyboard page's `Move pane left`, `Move pane right`, `Move terminal up` and `Move terminal down` — each announced through the console's live region.
- **Between windows** — a session view's title: the drag keeps pointer capture after the pointer leaves its window, and each move sends its screen point to main. Main hit-tests the other windows' bounds and names the window under the pointer, and that window draws its own drop indicator. Past every window, the renderer opens a tear-off window holding the view and main moves it with the pointer on each move; a release over the desktop leaves it there as a window of its own, and a release over another window docks the view into that window's row of views. A window a drag leaves with no view closes. The screen points, the window under the pointer, the tear-off's moves and the dock cross the `window` bridge members [Spec-021 §Preload Bridge Contract](../specs/021-desktop-app-and-renderer.md#preload-bridge-contract) names (`findWindowAt`, `startTearOff`, `moveTearOff`, `endTearOff`, `dockView`), carrying window ids and points and never a view.
- **Files from Finder and other apps into the composer**: the platform's native drop, unchanged.
- **Linux on Wayland**: Electron can neither move a window nor read the pointer outside its windows there, and it offers no call for `xdg_toplevel_drag`, the Wayland protocol Chrome carries a torn-off tab's window with. An add-on cannot call it through libwayland, because Electron's Chromium carries its own copy and exports none of its symbols; it reaches the compositor only by intercepting the app's socket to it and writing the protocol's messages into that stream, which one Electron app does for other Wayland requests and reports as unstable at times. Such a socket-intercepting add-on was considered and is held: it would carry a torn-off window on Wayland today, but every byte between the app and the compositor would pass through code of ours that its one known user reports as unstable at times, and the call upstream gives the same without it. It is looked at again when the Linux work starts, beside where the Electron change for #54650 stands ([BL-166](../backlog.md#bl-166-live-tear-off-on-wayland-waits-on-an-electron-api)). So on Wayland a session view's title drags with the platform's native drag from its start. A snapshot of the whole session view follows the pointer; another of the app's windows under the pointer draws its drop place, and a drop there docks the view; a drop in its own window swaps it as elsewhere; a release outside every window opens the view in a window of its own, placed by the compositor rather than at the release point. The drag carries only the app's own data type, so no other app's drop target reads it. The app stays a native Wayland client rather than running under XWayland, where the live tear-off works but text blurs at fractional scaling and one scale covers monitors of different density, and it ships no patched Electron. The call that closes the gap is sent upstream as our own change to Electron on [issue #54650](https://github.com/electron/electron/issues/54650): Chromium's `views::Widget::PrepareForMoveLoop` and `RunMoveLoop` already drive `xdg_toplevel_drag_v1`, so the change is a thin API over them, and the same call gives the native move loop on macOS, Windows and X11. Until a release carries it, the live tear-off on Wayland is a gap ([BL-166](../backlog.md#bl-166-live-tear-off-on-wayland-waits-on-an-electron-api)).

### Thesis — Why This Option

- **It is the only option measured with the item exactly on the pointer.** In the hands-on probe (macOS, Electron 44.5.1, a 120 Hz display, real OS mouse events), our own drag drew the item 0 px from the pointer on both axes, its neighbors glided at most 6.2 px a frame, and its drop glided into place in about 160 ms. Frames held 8.3 ms median and 9.3 ms at the 99th percentile, none over 16.7 ms.
- **It needs no frame clock**, so it is immune to the one-realm model's two traps: the hidden page's clock never fires, and a loop paced by one window stalls when that window closes. `pointermove` arrives in the window that owns the element and the glides run on that element's own document.
- **No library covers the cross-window half.** No drag library surveyed offers docking between windows or a live tear-off. VS Code, the one well-known app on the same one-realm model, uses native drag with listeners per window, keeps the dragged item in shared memory, and opens a new window where a drag ends outside every window; its window does not follow the pointer during the drag. Chrome is the precedent for a live tear-off: the torn-off window follows the pointer, moved per mouse-drag event on macOS, by the native move loop on Windows, and through `xdg_toplevel_drag` on Wayland.
- **The cross-window path is fast enough to be invisible.** Pointer capture kept delivering `pointermove` outside the window to the screen's edge, and a window main moved on each move followed about 10 px behind at about 650 px/s, about one refresh. Main's hit test took 0.2 ms, and the target window drew its indicator at its next frame: 8.8 ms median, 17.4 ms at the 95th percentile.
- **The code is small.** The in-window core has no dependency and, measured in the built renderer, came out smaller than the `@atlaskit/pragmatic-drag-and-drop` element adapter measured the same way ([Spec-021 §References](../specs/021-desktop-app-and-renderer.md#references)).

### Antithesis — The Strongest Case Against [T2]

Not required for a Type 1 decision.

### Synthesis — Why It Still Holds [T2]

Not required for a Type 1 decision.

---

## Alternatives Considered

The four libraries that could work were run in the same harness against our own: a strip of eight tabs and a stack of five rows in a visible window, one 1.5 s drag per list driven by real OS input. Follow error is the distance between the last `pointermove` the window saw and where the dragged item was drawn, sampled just before paint.

| Option | Works in a visible window as published | Follow, tabs (median / max) | Drop | Frames (median / p99, over 16.7 ms) | gzip over our own |
| --- | --- | --- | --- | --- | --- |
| Our own pointer drag | yes | 0 / 0 px | glides in, ~160 ms | 8.3 / 9.3 ms, 0 | 0 KB |
| `@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0 | yes | 1.9 / 6.4 px (one frame behind) | snaps 15 px in one frame | 8.3 / 9.3 ms, 0 | +13.9 KB |
| `motion` 14.0.0 `Reorder`, its frame clock rerouted to a visible window | only with the reroute | 0 / 2.1 px | creeps in at under 1 px a frame, ~0.5 s | 8.3 / 9.3 ms, 0 | +43.1 KB |
| `motion` 14.0.0 `Reorder`, as published | no | 199 / 385 px, order wrong | item stuck off its slot | 8.3 / 9.2 ms, 0 | +43.1 KB |
| `@atlaskit/pragmatic-drag-and-drop` 4.0.0 | no | no event reaches it | — | — | — |

### Option A: Our own pointer drag, our own cross-window controller (Chosen)

- **What:** Pointer capture, a `transform` on the real item, FLIP glides with `element.animate` on the element's own document, a glide on drop; between windows, main's hit test from screen points and a live tear-off window main moves; native drop for files; on Wayland, the platform's native drag for a session view's title.
- **Steel man:** The smoothest measured option on every axis, no frame clock, no dependency, and the only path to a live tear-off.
- **Weaknesses:** We own the code, its edge cases (autoscroll at a list's ends, a drag canceled by Escape or a lost capture) and its tests. On Wayland a torn-off view's window does not follow the pointer and opens where the compositor places it.

### Option B: `@atlaskit/pragmatic-drag-and-drop` (Rejected)

- **What:** Atlassian's headless drag library on native HTML5 drag.
- **Why rejected:** It binds `dragstart` on the module's global `document` (`dist/esm/adapter/element-adapter.js`) and `dragover` and `drop` on the global `window` (`dist/esm/ledger/lifecycle-manager.js`); in this model those are the hidden page's, so a drag in a visible window reaches no listener — measured 0 events, and all events once a copy of the library was loaded in the window itself. Its maintainer's stated model is one copy per window: "Pragmatic drag and drop expects each window to manage it's own drag and drop rather than one window trying to manage another" ([issue #24](https://github.com/atlassian/pragmatic-drag-and-drop/issues/24)), and Slack's request for exactly our model was closed as not planned ([issue #123](https://github.com/atlassian/pragmatic-drag-and-drop/issues/123)). Native drag itself also fails the requirement: the drag image is a static snapshot fixed at `dragstart` ([WHATWG drag-and-drop processing model](https://html.spec.whatwg.org/multipage/dnd.html#drag-and-drop-processing-model)), and the dragged data cannot be read during `dragover` ([protected mode](https://html.spec.whatwg.org/multipage/dnd.html#concept-dnd-p)).

### Option C: `@dnd-kit/core` and `@dnd-kit/sortable` (Rejected)

- **What:** The most used React drag kit, on pointer events.
- **Why rejected:** It works in a visible window unpatched, because its sensors listen on the element's own document, but the item trails the pointer by one frame (it moves through a React render) and snaps 15 px in one frame on release. `@dnd-kit/core` has had no release since December 2024, and its maintainer's effort is on `@dnd-kit/react` and `@dnd-kit/dom` 0.x ([discussion #1803](https://github.com/clauderic/dnd-kit/discussions/1803)), whose pointer sensor listens on the global document plus its iframes and never reaches a `window.open` window. It offers nothing between windows.

### Option D: `motion` and its `Reorder` (Rejected)

- **What:** The animation library's drag and layout-animation reorder.
- **Why rejected:** Its drag listeners use the element's own window, the fix for [motion issue #2270](https://github.com/motiondivision/motion/issues/2270), but its single frame loop reads the global `requestAnimationFrame` once, when the module loads (`motion-dom` `frameloop/frame`). In this model that is the hidden page's clock, which never fires, so as published the dragged row stuck up to 385 px off the pointer and the order came out wrong. Rerouting the clock to a visible window before the module loads makes it work, but then one window paces every animation in every window, and the loop stalls for good when that window closes unless the reroute re-arms on another. Its drop creeps into place over about half a second, and it adds 43 KB gzip.

### Option E: Native code for the drag itself (Rejected)

- **What:** Move the dragged item from Rust or C++ rather than from the page.
- **Why rejected:** The per-frame work is one `transform` write in the page that owns the element. Native code cannot touch a DOM element and would add a process boundary to every move, while the page already draws at the display's full rate.

### Option F: Every other library surveyed (Rejected)

- SortableJS: its pointer fallback listens on the global document.
- react-dnd: last release in 2022, and one HTML5 backend per window root.
- react-aria's drag hooks: native drag with a static image, scheduled on the global, hidden-page frame clock.
- `@hello-pangea/dnd`: its sensors bind the global `window`.
- `@use-gesture/react`: no release since March 2024, and it moves nothing itself.
- interact.js, `@formkit/drag-and-drop`, Shopify's draggable (archived), swapy (GPL-3.0).
- dockview, flexlayout-react, rc-dock and golden-layout: whole layout systems with their own panes, chrome and stylesheets; golden-layout's pop-out loads a second copy of the app in its own realm.
- electron-tabs: archived, with no tear-off.

None offers docking between windows or a live tear-off.

---

## Assumptions Audit [T2]

Not required for a Type 1 decision.

---

## Failure Mode Analysis [T2]

Not required for a Type 1 decision.

## Reversibility Assessment

- **Reversal cost:** Days. The drag core sits behind one hook per drag kind; a library could replace it list by list.
- **Blast radius:** The four drag uses. Keyboard and menu reorder paths and the native file drop are untouched by a reversal.
- **Migration path:** Swap the hook's internals; the stores that hold the orders are the same.
- **Point of no return:** None. Wayland's native drag for a view's title is a separate path, stands whichever in-window drag is used, and gives way to the live tear-off if Electron offers a call for `xdg_toplevel_drag`.

## Consequences

### Positive

- The dragged item is exactly under the pointer, neighbors glide, and the drop glides, in every window.
- A session view tears off live and docks into any window.
- No drag dependency to keep current, and no frame-clock reroute for any library.

### Negative (accepted trade-offs)

- The drag core, plus the cross-window controller in main, are ours to maintain and test.
- On Linux under Wayland a torn-off view's window does not follow the drag and opens where the compositor places it, not under the pointer: sharp text on native Wayland is kept over XWayland's live tear-off, and no patched Electron is built.
- Preview, a native page placed by main, cannot follow a moving pane frame for frame, so while its pane moves — a sideways scroll of the row of panes, a drag, a resize — it shows a still picture of itself and the live page returns when the motion stops; a video playing in the page pauses meanwhile ([Spec-021 §Pane kinds](../specs/021-desktop-app-and-renderer.md#pane-kinds)).

### Unknowns

- How Windows behaves for a window main moves on each `pointermove`; Chrome uses the native move loop there. Measured with the Windows leg.
- On Wayland, how a release over the desktop is told apart from a drag canceled with Escape, since both end the native drag with no drop. Measured with the Linux leg.

---

## Decision Validation [T2]

Not required for a Type 1 decision.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Hands-on drag probes in the one-realm model | Primary research | 2026-10-05, Electron 44.5.1, macOS 27 on Apple silicon, 120 Hz, real OS mouse events: the measured table above; the hidden page's `requestAnimationFrame` fired 0 times; a hidden-realm `ResizeObserver` reported 0 times on a visible window's node | Local probe, recorded here |
| Cross-window probes | Primary research | Same setup: pointer capture delivered `pointermove` outside the window to the screen's edge; a window main moved on each move followed ~10 px behind at ~650 px/s; main's hit test 0.2 ms; the target's indicator at its next frame, 8.8 ms median, 17.4 ms p95; native `dragover` every ~6 ms while moving; a native drag dropped on the desktop reported `dragend` ~569 ms after release (macOS slides a refused drop back) and another app may accept the drop | Local probe, recorded here |
| WHATWG HTML drag-and-drop processing model | Spec | The drag image is set only during `dragstart`; the drag steps fire `drag` and `dragover` | https://html.spec.whatwg.org/multipage/dnd.html#drag-and-drop-processing-model |
| WHATWG HTML protected mode | Spec | During `dragenter`, `dragover`, `dragleave` and `dragend` the data's types can be listed but the data itself is unavailable | https://html.spec.whatwg.org/multipage/dnd.html#concept-dnd-p |
| pragmatic-drag-and-drop issue #24 | Issue | Maintainer: "Pragmatic drag and drop expects each window to manage it's own drag and drop rather than one window trying to manage another" | https://github.com/atlassian/pragmatic-drag-and-drop/issues/24 |
| pragmatic-drag-and-drop issue #123 | Issue | Slack's request to pass a `window` for child windows managed from one realm, closed as not planned | https://github.com/atlassian/pragmatic-drag-and-drop/issues/123 |
| dnd-kit discussion #1803 | Issue | The maintainer's development effort goes to the next major, `@dnd-kit/react` and `@dnd-kit/dom` | https://github.com/clauderic/dnd-kit/discussions/1803 |
| motion issue #2270 | Issue | "window.open with portals don't pick the correct window for events", fixed by resolving the element's own window for drag listeners; the frame loop still reads the global clock | https://github.com/motiondivision/motion/issues/2270 |
| VS Code `editorTabsControl.ts` | Source file | Native drag; on `dragend` outside every window it reads the cursor's screen point and opens an auxiliary window there; the window does not follow the drag | https://github.com/microsoft/vscode/blob/3d5764c14dea123b0fd50fb61788328c33c076b8/src/vs/workbench/browser/parts/editor/editorTabsControl.ts#L523 |
| Chrome `tab_drag_controller.cc` | Source file | A torn-off tab's window follows the pointer: moved per mouse-drag event on macOS, by the native move loop on Windows | https://github.com/chromium/chromium/blob/3387abbe4b6dfd1f8172fe8c293a74d54f1b8f75/chrome/browser/ui/views/tabs/dragging/tab_drag_controller.cc |
| Chrome `wayland_window_drag_controller.cc` | Source file | On Wayland the compositor carries the torn-off window through `xdg_toplevel_drag_v1_attach` | https://github.com/chromium/chromium/blob/3387abbe4b6dfd1f8172fe8c293a74d54f1b8f75/ui/ozone/platform/wayland/host/wayland_window_drag_controller.cc |
| `xdg-toplevel-drag-v1` | Spec | The Wayland protocol that attaches a toplevel window to a drag so it moves with the pointer | https://wayland.app/protocols/xdg-toplevel-drag-v1 |
| Electron 44.5.1 linux-arm64 binary | Primary research | 2026-10-05: no libwayland among its needed libraries and no `wl_` symbol exported, while the binary holds `xdg_toplevel_drag_v1`; an add-on or a hook on the system libwayland cannot reach Chromium's own copy | Local probe, recorded here |
| open-orpheus `modules/window/src/linux/` | Source file | An Electron 44.5.1 app whose Rust add-on hooks `connect`, proxies the Wayland socket through a socket pair and injects requests (`xdg_toplevel.move`, input regions, layer shell) | https://github.com/YUCLing/open-orpheus/tree/main/modules/window/src/linux |
| Electron issue #54650 | Issue | Requests a call that attaches a window to a pointer drag, backed on Wayland by `xdg_toplevel_drag_v1.attach` | https://github.com/electron/electron/issues/54650 |
| Electron issue #50133 | Issue | Asks Electron to expose Wayland events and serials; the author's socket-intercepting workaround "works for most of time, but sometimes is still unstable" | https://github.com/electron/electron/issues/50133 |
| Electron `screen` | Documentation | `screen.getCursorScreenPoint()`: "Not supported on Wayland (Linux)" | https://www.electronjs.org/docs/latest/api/screen |
| Electron `BaseWindow` | Documentation | On Wayland, `getPosition` returns `[0, 0]` "as introspecting or programmatically changing the global window coordinates is prohibited" | https://www.electronjs.org/docs/latest/api/base-window |
| Electron `BrowserWindow` | Documentation | "On Wayland (Linux) it is generally not possible … to position, move, focus, or blur windows without user input" | https://www.electronjs.org/docs/latest/api/browser-window |
| Zed issue #6722 | Issue | "Drag tab to open new window" is still an open request: Zed cannot drag a tab between windows | https://github.com/zed-industries/zed/issues/6722 |

### Related ADRs

- [ADR-015](./015-electron-desktop-app.md) — Electron as the desktop framework, whose window model this decision works within.
- [ADR-023](./023-electron-main-process-window-retention.md) — main's registry of windows, which the cross-window hit test reads.
- [ADR-034](./034-embedded-browser-for-preview.md) — Preview's native page, which shows a still picture while its pane moves.
