// The windows the console document opens, as iframes filling this test page. Each is a document
// and a window of its own, as `window.open` gives the console document in the app, so a suite
// drives the app across a real document boundary: its stylesheets copied in, its listeners on the
// window it is drawn in, and its frames paced by that window.

/** Opens each window as an iframe over the whole page, and removes them all at the end. */
export class FrameWindows {
  readonly #frames = new Map<string, HTMLIFrameElement>();

  /** The opener the app is handed: one iframe per window id, its window answered. */
  public readonly open = (windowId: string): Window | null => {
    const frame = document.createElement("iframe");
    frame.name = windowId;
    frame.title = windowId;
    frame.style.cssText = "position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0;";
    document.body.append(frame);
    this.#frames.set(windowId, frame);
    return frame.contentWindow;
  };

  /** The window opened under `windowId`; throws when none was. */
  public windowNamed(windowId: string): Window {
    const opened = this.#frames.get(windowId)?.contentWindow ?? undefined;
    if (opened === undefined) {
      throw new Error(`No window was opened under ${windowId}.`);
    }
    return opened;
  }

  /** The ids of the windows opened, in the order they were. */
  public openedIds(): readonly string[] {
    return [...this.#frames.keys()];
  }

  /** Remove every iframe, as closing the app's windows would. */
  public removeAll(): void {
    for (const frame of this.#frames.values()) {
      frame.remove();
    }
    this.#frames.clear();
  }
}
