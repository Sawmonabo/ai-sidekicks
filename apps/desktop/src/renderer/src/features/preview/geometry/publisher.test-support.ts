// The fixtures every geometry-publisher suite shares: a page host that records what it was
// handed, a box the test decides, and a way to move it. The publisher itself is constructed by
// each suite, because how it is constructed is part of what each suite is about.

import type { PaneGeometrySample, PaneRect } from "./pane-geometry.js";
import type { PageHost } from "./page-host.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";

/** A page host that records what it was handed, and can be told to reject. */
export class RecordingPageHost implements PageHost {
  public readonly transport = "recording";
  public readonly samples: PaneGeometrySample[] = [];
  #rejection: Refusal | undefined;

  public rejectNextWith(refusal: Refusal): void {
    this.#rejection = refusal;
  }

  public setRect(sample: PaneGeometrySample): ReturnType<PageHost["setRect"]> {
    this.samples.push(sample);
    return this.#rejection === undefined
      ? { status: "accepted" }
      : { status: "rejected", refusal: this.#rejection };
  }
}

/** A pane rectangle from its four numbers. */
export function rect(x: number, y: number, width: number, height: number): PaneRect {
  return { x, y, width, height };
}

/** Put an element's box where the test wants it, standing in for a relayout. */
export function moveElementRect(element: HTMLElement, box: PaneRect): void {
  element.getBoundingClientRect = (): DOMRect =>
    ({
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
    }) as DOMRect;
}

/** An element whose box the test decides, standing in for a laid-out host element. */
export function elementWithRect(box: PaneRect): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  moveElementRect(element, box);
  return element;
}
