// A window's minimum size: the floor the console document asks for, held within the work area of
// the display the window is on, in whole pixels. A floor past that work area would leave the
// window larger than its display, so the hold is worked out again whenever the window moves or a
// display's metrics change, and a window left larger than its display's work area is shrunk to fit
// it: a window dragged onto a smaller display fits it, and one dragged back gets its whole floor
// again. A move sets the minimum only when the hold it works out changes, and the bounds only when
// the window does not fit.

import type { BaseWindow, Rectangle, Screen } from "electron";

import type { WindowSize } from "#shared/window/size.js";

/** A window with a floor: the size asked for, and the minimum size last set from it. */
interface HeldFloor {
  readonly asked: WindowSize;
  applied: readonly [number, number] | undefined;
}

/** The windows' floors, each held within the display its window is on. */
export class WindowFloors {
  readonly #screen: Pick<Screen, "getDisplayMatching" | "on">;
  readonly #floors = new Map<BaseWindow, HeldFloor>();
  #isWatchingDisplays = false;

  /** Takes the screen the work areas are read from; nothing is read before the first floor. */
  public constructor(screen: Pick<Screen, "getDisplayMatching" | "on">) {
    this.#screen = screen;
  }

  /** Holds `asked` as `baseWindow`'s floor, within its display now and after every move. */
  public hold(baseWindow: BaseWindow, asked: WindowSize): void {
    if (!this.#floors.has(baseWindow)) {
      // `move`, since `moved` never fires on Linux; a move that keeps the hold sets nothing.
      baseWindow.on("move", () => {
        this.#apply(baseWindow);
      });
      baseWindow.once("closed", () => {
        this.#floors.delete(baseWindow);
      });
    }
    this.#floors.set(baseWindow, { asked, applied: undefined });
    this.#watchDisplays();
    this.#apply(baseWindow);
  }

  // Listens once, from the first floor on: `screen` answers only once the app is ready.
  #watchDisplays(): void {
    if (this.#isWatchingDisplays) {
      return;
    }
    this.#isWatchingDisplays = true;
    this.#screen.on("display-metrics-changed", () => {
      for (const baseWindow of this.#floors.keys()) {
        this.#apply(baseWindow);
      }
    });
  }

  #apply(baseWindow: BaseWindow): void {
    const floor = this.#floors.get(baseWindow);
    if (floor === undefined) {
      return;
    }
    const bounds = baseWindow.getBounds();
    const { workArea } = this.#screen.getDisplayMatching(bounds);
    // The platform takes whole pixels; rounding up keeps the floor from cutting a part off.
    const width = Math.min(Math.ceil(floor.asked.width), workArea.width);
    const height = Math.min(Math.ceil(floor.asked.height), workArea.height);
    if (floor.applied?.[0] !== width || floor.applied[1] !== height) {
      floor.applied = [width, height];
      baseWindow.setMinimumSize(width, height);
    }
    // After the floor, which would otherwise stop the platform shrinking the window that far.
    if (bounds.width > workArea.width || bounds.height > workArea.height) {
      baseWindow.setBounds(fitWithin(bounds, workArea));
    }
  }
}

// Shrinks `bounds` to `workArea` on each side it is larger on, starting it at the work area's edge
// there; a side that already fits keeps its size and place.
function fitWithin(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const isTooWide = bounds.width > workArea.width;
  const isTooTall = bounds.height > workArea.height;
  return {
    x: isTooWide ? workArea.x : bounds.x,
    y: isTooTall ? workArea.y : bounds.y,
    width: isTooWide ? workArea.width : bounds.width,
    height: isTooTall ? workArea.height : bounds.height,
  };
}
