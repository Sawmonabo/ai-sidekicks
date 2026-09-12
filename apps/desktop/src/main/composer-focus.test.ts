// The composer chord in an auxiliary window.
//
// Four properties, and each one is a way the press goes wrong rather than a
// restatement of the handler's shape:
//
//   1. The chord brings the composer's window forward, and a minimised one is
//      restored first — `show()` alone leaves a minimised window minimised on
//      Windows and Linux, so the person would press and see nothing move.
//   2. It then ASKS that window for the caret, on the shared channel and exactly
//      once. `focus()` keys a window and moves no DOM focus, so without the ask a
//      person whose main window was last on a ledger row is returned to that row.
//   3. The press is CONSUMED only when it was acted on. Consuming it with no
//      window to go to would swallow a keystroke the renderer may bind.
//   4. `keyUp` is ignored. Electron delivers both halves of one press, and a
//      handler that ran on each would perform the act twice — and ask twice.
//   5. The window that HAS the composer is never watched. Consuming the chord
//      there would take it away from the binding that moves the caret.
//
// No `electron` mock: this module imports only types from it, and `window-reveal.ts`
// beneath it does the same, so the whole path under test is ordinary TypeScript.

import { type BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import { COMPOSER_FOCUS_REQUEST_CHANNEL } from "../shared/composer-chord.js";
import {
  installComposerFocusChord,
  watchAuxiliaryWindowsForComposerChord,
  type ComposerChordHostWindow,
  type ComposerFocusTargetWindow,
} from "./composer-focus.js";

/** The `before-input-event` payload members this module reads. */
interface ChordInput {
  readonly type: string;
  readonly code: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** Electron's `before-input-event` listener, as this module registers one. */
type BeforeInputListener = (event: { preventDefault: () => void }, input: ChordInput) => void;

/** A window whose registered listener a case can invoke. */
interface HostWindowProbe {
  readonly window: ComposerChordHostWindow;
  /** The listener the module registered, or `undefined` if it registered none. */
  listener: BeforeInputListener | undefined;
}

function hostWindowProbe(): HostWindowProbe {
  const probe: HostWindowProbe = {
    listener: undefined,
    window: {
      webContents: {
        on: vi.fn((eventName: string, listener: BeforeInputListener) => {
          if (eventName === "before-input-event") {
            probe.listener = listener;
          }
        }),
      },
    } as unknown as ComposerChordHostWindow,
  };
  return probe;
}

/**
 * The acts a target window records, so a case reads what happened to it.
 *
 * The send is recorded in the SAME list as the window acts rather than in a counter
 * beside them, because the order is half of what is being claimed: asking for the
 * caret before the window is on screen would move focus in a document nobody is
 * looking at.
 */
interface TargetWindowProbe extends ComposerFocusTargetWindow {
  readonly acts: string[];
}

function targetWindowProbe(
  state: {
    readonly destroyed?: boolean;
    readonly minimized?: boolean;
    readonly visible?: boolean;
  } = {},
): TargetWindowProbe {
  const acts: string[] = [];
  return {
    acts,
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    isVisible: () => state.visible ?? true,
    restore: () => {
      acts.push("restore");
    },
    focus: () => {
      acts.push("focus");
    },
    show: () => {
      acts.push("show");
    },
    showInactive: () => {
      acts.push("showInactive");
    },
    webContents: {
      // The channel is recorded rather than counted, so a send on a name the preload
      // does not listen on reads as a different act instead of as the right one.
      send: (channel: string) => {
        acts.push(`send:${channel}`);
      },
    },
  };
}

/** What the target records for one answered press: reveal, keys, then the ask. */
const REVEALED_AND_ASKED: readonly string[] = [
  "show",
  "focus",
  `send:${COMPOSER_FOCUS_REQUEST_CHANNEL}`,
];

/** One `keyDown` of the chord as Electron reports it on a control-modifier host. */
const CHORD_KEY_DOWN: ChordInput = {
  type: "keyDown",
  code: "KeyL",
  control: true,
  meta: false,
  alt: false,
  shift: false,
};

/** Press the chord at `host` and answer whether the press was consumed. */
function press(host: HostWindowProbe, input: ChordInput): boolean {
  let consumed = false;
  host.listener?.(
    {
      preventDefault: () => {
        consumed = true;
      },
    },
    input,
  );
  return consumed;
}

describe("the composer chord brings the composer's window forward", () => {
  it("reveals and focuses a visible window, and consumes the press", () => {
    const host = hostWindowProbe();
    const target = targetWindowProbe();
    installComposerFocusChord(host.window, () => target, "linux");

    expect(press(host, CHORD_KEY_DOWN)).toBe(true);
    expect(target.acts).toEqual(REVEALED_AND_ASKED);
  });

  it("asks that window's composer for the caret, once, after it is on screen", () => {
    // The half `focus()` cannot do. A `BrowserWindow` takes keys as a window; the
    // caret belongs to an element inside it, and the element belongs to a renderer
    // this process cannot reach into. Without the ask the person is returned to
    // whichever control the main window last had focus on — a ledger row, the
    // sidebar — and the chord that says "composer" delivers them somewhere else.
    const host = hostWindowProbe();
    const target = targetWindowProbe();
    installComposerFocusChord(host.window, () => target, "linux");

    press(host, CHORD_KEY_DOWN);

    expect(target.acts.filter((act) => act.startsWith("send:"))).toEqual([
      `send:${COMPOSER_FOCUS_REQUEST_CHANNEL}`,
    ]);
    // And it is the LAST act, not the first: a caret moved before the window is up
    // lands in a document nobody is looking at.
    expect(target.acts.at(-1)).toBe(`send:${COMPOSER_FOCUS_REQUEST_CHANNEL}`);
  });

  it("restores a minimised window before revealing it", () => {
    // `show()` on a minimised window leaves it minimised on Windows and Linux, so
    // without the restore the person presses the chord and nothing appears.
    const host = hostWindowProbe();
    const target = targetWindowProbe({ minimized: true });
    installComposerFocusChord(host.window, () => target, "linux");

    press(host, CHORD_KEY_DOWN);
    expect(target.acts).toEqual(["restore", ...REVEALED_AND_ASKED]);
  });

  it("does not order keys onto a window that was not revealed, and asks it anyway", () => {
    // The unobtrusive-window policy's half of the act: a window that is not on
    // screen must not take focus, which is what `window-reveal.ts` exists to hold.
    // The ASK is not held back with it, because it governs the screen and moving the
    // caret inside a window takes nothing from the operator's current application —
    // so an automated tier answers the chord in the document it already has instead
    // of answering it by doing nothing at all.
    const host = hostWindowProbe();
    const target = targetWindowProbe({ visible: false });
    installComposerFocusChord(host.window, () => target, "linux");

    press(host, CHORD_KEY_DOWN);
    expect(target.acts).toEqual(["show", `send:${COMPOSER_FOCUS_REQUEST_CHANNEL}`]);
  });

  it("answers the macOS modifier only on a macOS host", () => {
    const host = hostWindowProbe();
    const target = targetWindowProbe();
    installComposerFocusChord(host.window, () => target, "darwin");

    expect(press(host, CHORD_KEY_DOWN)).toBe(false);
    expect(press(host, { ...CHORD_KEY_DOWN, control: false, meta: true })).toBe(true);
    expect(target.acts).toEqual(REVEALED_AND_ASKED);
  });
});

describe("the composer chord leaves a press it cannot act on", () => {
  it("consumes nothing when there is no composer window", () => {
    const host = hostWindowProbe();
    installComposerFocusChord(host.window, () => null, "linux");

    expect(press(host, CHORD_KEY_DOWN)).toBe(false);
  });

  it("consumes nothing when the composer window is gone", () => {
    // Every other method on a destroyed `BrowserWindow` throws, so the check is
    // first and the press is left to the page.
    const host = hostWindowProbe();
    const target = targetWindowProbe({ destroyed: true });
    installComposerFocusChord(host.window, () => target, "linux");

    expect(press(host, CHORD_KEY_DOWN)).toBe(false);
    expect(target.acts).toEqual([]);
  });

  it("ignores the key-up half of one press", () => {
    // Electron delivers `keyDown` and `keyUp` for one press. Acting on both runs
    // the act twice and consumes a `keyUp` whose `keyDown` the page never saw.
    const host = hostWindowProbe();
    const target = targetWindowProbe();
    installComposerFocusChord(host.window, () => target, "linux");

    expect(press(host, { ...CHORD_KEY_DOWN, type: "keyUp" })).toBe(false);
    expect(target.acts).toEqual([]);
  });

  it("ignores an ordinary keystroke", () => {
    const host = hostWindowProbe();
    const target = targetWindowProbe();
    installComposerFocusChord(host.window, () => target, "linux");

    expect(press(host, { ...CHORD_KEY_DOWN, code: "KeyK" })).toBe(false);
    expect(target.acts).toEqual([]);
  });
});

/** The `app` surface the watcher registers on, and a way to open a window. */
interface AppProbe {
  readonly app: Parameters<typeof watchAuxiliaryWindowsForComposerChord>[0];
  open: (created: BrowserWindow) => void;
}

function appProbe(): AppProbe {
  let created: ((event: unknown, window: BrowserWindow) => void) | undefined;
  return {
    app: {
      on: vi.fn((eventName: string, listener: (event: unknown, window: BrowserWindow) => void) => {
        if (eventName === "browser-window-created") {
          created = listener;
        }
      }),
    } as unknown as Parameters<typeof watchAuxiliaryWindowsForComposerChord>[0],
    open: (window: BrowserWindow) => {
      created?.({}, window);
    },
  };
}

describe("the watcher never installs the chord on the composer's own window", () => {
  it("installs on a window that is not the composer's", () => {
    const probe = appProbe();
    const host = hostWindowProbe();
    watchAuxiliaryWindowsForComposerChord(probe.app, () => null, "linux");
    probe.open(host.window as unknown as BrowserWindow);

    expect(host.listener).toBeDefined();
  });

  it("skips the window the getter names as the composer's", () => {
    // The rule stated where a reader looks for it. Without it, a caller that
    // registered the watcher before the main window existed would consume the
    // chord in the very window whose composer it is meant to reach.
    const probe = appProbe();
    const host = hostWindowProbe();
    const composerWindow = host.window as unknown as BrowserWindow;
    watchAuxiliaryWindowsForComposerChord(probe.app, () => composerWindow, "linux");
    probe.open(composerWindow);

    expect(host.listener).toBeUndefined();
  });
});
