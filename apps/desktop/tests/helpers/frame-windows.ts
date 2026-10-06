// The windows the console document opens, as iframes filling this test page. Each is a document
// and a window of its own, as `window.open` gives the console document in the app, so a suite
// drives the app across a real document boundary: its stylesheets copied in, its listeners on the
// window it is drawn in, and its frames paced by that window. Each behaves as a real window does:
// opening a name already open answers that window, and `close()` takes the window away.

/** Opens each window as an iframe over the whole page, and removes them all at the end. */
export class FrameWindows {
  readonly #frames = new Map<string, HTMLIFrameElement>();

  /** The opener the app is handed: one iframe per window id, its window answered. */
  public readonly open = (windowId: string): Window | null => {
    const known = this.#frames.get(windowId);
    if (known !== undefined) {
      return known.contentWindow;
    }
    const frame = document.createElement("iframe");
    frame.name = windowId;
    frame.title = windowId;
    frame.style.cssText = "position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0;";
    document.body.append(frame);
    this.#frames.set(windowId, frame);
    const opened = frame.contentWindow;
    if (opened !== null) {
      // An iframe's own `close()` does nothing. Removing the frame unloads its document, and its
      // window then reads `closed`, as a closed window does.
      opened.close = () => {
        this.#remove(windowId);
      };
    }
    return opened;
  };

  /** The window open under `windowId`; throws when none is. */
  public windowNamed(windowId: string): Window {
    const opened = this.#frames.get(windowId)?.contentWindow ?? undefined;
    if (opened === undefined) {
      throw new Error(`No window is open under ${windowId}.`);
    }
    return opened;
  }

  /** The ids of the windows open, in the order they were opened. */
  public openedIds(): readonly string[] {
    return [...this.#frames.keys()];
  }

  /** Remove every iframe, as closing the app's windows would. */
  public removeAll(): void {
    for (const windowId of [...this.#frames.keys()]) {
      this.#remove(windowId);
    }
  }

  #remove(windowId: string): void {
    this.#frames.get(windowId)?.remove();
    this.#frames.delete(windowId);
  }
}
