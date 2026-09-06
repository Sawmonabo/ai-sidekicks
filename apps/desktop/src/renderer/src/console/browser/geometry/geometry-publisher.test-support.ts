// The four fixtures every geometry-publisher suite needs before it can ask anything.
//
// One home rather than a copy per suite, on this package's rule that shared
// scaffolding lives once: every suite beside this file that publishes geometry needs a
// host that records what it was handed, a box the test decides, and a way to move that
// box — and a fixture copied per suite is a fixture that drifts, with the copy that
// drifted being the one whose suite then passes for the wrong reason. The number of
// suites is deliberately not stated: it moves with every case file the family adds,
// and a count in prose is a claim nothing checks.
//
// A `.test-support.ts` and not a `.fixtures.ts`, which is what the package's own
// conventions call this role: the layering gate exempts that suffix from its orphan
// rule (a module whose only dependents are the test files the cruise excludes reads
// as disconnected), and every other shared test role in this tree already carries it.
//
// NOTHING HERE DRIVES THE MODULE UNDER TEST. The publisher is constructed by each
// suite, because how it is constructed is part of what each of them is about — one
// arms nothing, one runs a frame before it asserts, one installs a size observer
// first. What is shared is the world the publisher is pointed at.

import type { PaneGeometrySample, PaneRect } from "./pane-geometry.js";
import type { AttachedPaneViewHost } from "./view-host.js";
import type { ConsoleRefusal } from "../../core/index.js";

export function rect(x: number, y: number, width: number, height: number): PaneRect {
  return { x, y, width, height };
}

/** A host that records what it was handed, and can be told to reject. */
export class RecordingViewHost implements AttachedPaneViewHost {
  public readonly state = "attached" as const;
  public readonly transport = "recording";
  public readonly samples: PaneGeometrySample[] = [];
  #rejection: ConsoleRefusal | undefined;

  public rejectNextWith(refusal: ConsoleRefusal): void {
    this.#rejection = refusal;
  }

  public setRect(sample: PaneGeometrySample): ReturnType<AttachedPaneViewHost["setRect"]> {
    this.samples.push(sample);
    return this.#rejection === undefined
      ? { status: "accepted" }
      : { status: "rejected", refusal: this.#rejection };
  }
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

/** An element whose box the test decides, standing in for a laid-out host. */
export function elementWithRect(box: PaneRect): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  moveElementRect(element, box);
  return element;
}
