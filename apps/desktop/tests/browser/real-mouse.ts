// A mouse driven through the browser's own input pipeline (CDP `Input.dispatchMouseEvent`), for
// the browser tier's cases that need what only real input does: pointer capture holds only for a
// pointer whose button the browser itself saw pressed. Its mapping into the top page also places a
// document's point on a picture of the page.

import { cdp } from "vitest/browser";

/** A point in a document's viewport, or in the top page's, in CSS pixels. */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Drives the mouse through CDP. CDP speaks in the top page's coordinates and the test runs in an
 * iframe inside it, so the mapping from a document's viewport is measured from two real moves
 * that document sees, rather than assumed.
 */
export class RealMouse {
  readonly #origin: ViewportPoint;
  readonly #scale: number;

  private constructor(origin: ViewportPoint, scale: number) {
    this.#origin = origin;
    this.#scale = scale;
  }

  public static async calibrated(viewportDocument: Document): Promise<RealMouse> {
    const seen: ViewportPoint[] = [];
    const record = (event: PointerEvent): void => {
      seen.push({ x: event.clientX, y: event.clientY });
    };
    viewportDocument.addEventListener("pointermove", record);
    try {
      await sendMouse("mouseMoved", { x: 200, y: 200 }, 0);
      await sendMouse("mouseMoved", { x: 400, y: 400 }, 0);
    } finally {
      viewportDocument.removeEventListener("pointermove", record);
    }
    const [first, second] = [seen.at(-2), seen.at(-1)];
    if (first === undefined || second === undefined) {
      throw new Error("The document saw no pointer move from CDP input.");
    }
    const scale = 200 / (second.x - first.x);
    return new RealMouse({ x: 200 - first.x * scale, y: 200 - first.y * scale }, scale);
  }

  public async press(at: ViewportPoint): Promise<void> {
    await sendMouse("mouseMoved", this.toPage(at), 0);
    await sendMouse("mousePressed", this.toPage(at), 1);
  }

  /** Moves with the button held, in steps, as a hand does. */
  public async dragTo(from: ViewportPoint, to: ViewportPoint, steps: number): Promise<void> {
    for (let step = 1; step <= steps; step += 1) {
      const point = {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      };
      await sendMouse("mouseMoved", this.toPage(point), 1);
    }
  }

  public async release(at: ViewportPoint): Promise<void> {
    await sendMouse("mouseReleased", this.toPage(at), 0);
  }

  /** Where a point of the calibrated document's viewport stands in the top page's. */
  public toPage(point: ViewportPoint): ViewportPoint {
    return {
      x: this.#origin.x + point.x * this.#scale,
      y: this.#origin.y + point.y * this.#scale,
    };
  }
}

async function sendMouse(
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  at: ViewportPoint,
  buttons: number,
): Promise<void> {
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}
