// The overlay set the native view yields to.
//
// `Spec-023 §Console Design (Meridian)` 12.3: "Every overlay primitive registers its
// own rectangle on mount … The visibility predicate consults the registry, and an
// overlay whose rectangle intersects the pane makes the view yield. Registration
// happens once, at the primitive layer, never per overlay instance." The wire table
// for the same surface reads `renderer-local`, and this module is that locality.
//
// WHERE THIS WILL EVENTUALLY LIVE. `primitives/` sits BELOW this family in the
// console's DAG, so an overlay primitive cannot import this module: the registry is
// hoisted into `core/` by the task that adds the first overlay primitive, and its
// consumers move with it. It is minted here because this is the surface that reads
// it, and a registry nobody can reach is a plan rather than a seam.

import { Emitter, type Unsubscribe } from "../core/index.js";
import type { PaneOverlaySource, PaneRect } from "./pane-geometry.js";

/** One overlay's live rectangle, read at the moment the predicate asks. */
export type OverlayRectReader = () => PaneRect | undefined;

/**
 * The overlay kinds 12.3 enumerates. Closed, and the enumeration is the claim: a new
 * overlay primitive joins this tuple in the edit that makes it register.
 */
export const OVERLAY_KINDS = [
  "dialog",
  "popover",
  "context-menu",
  "toast",
  "command-palette",
  "image-lightbox",
  "diagram-lightbox",
] as const;

export type OverlayKind = (typeof OVERLAY_KINDS)[number];

interface RegisteredOverlay {
  readonly kind: OverlayKind;
  readonly read: OverlayRectReader;
}

/**
 * Which overlays are on screen right now, as a set of rectangle READERS.
 *
 * Readers rather than rectangles because an overlay animates: a rectangle captured at
 * registration is where the overlay was before it opened, and the view would yield to
 * a box that has moved. A class rather than a module-level `Set` because an auxiliary
 * window is its own renderer process with its own overlays.
 */
export class PaneOcclusionRegistry implements PaneOverlaySource {
  readonly #overlaysByToken = new Map<number, RegisteredOverlay>();
  readonly #changeEmitter = new Emitter<void>("overlay registration change");
  #nextToken = 1;

  /**
   * Register one live overlay. The disposer is the only removal, so an overlay that
   * unmounts without disposing keeps the view hidden — the fail-closed direction: a
   * stuck-hidden view is a visible bug, a view painted over a dialog is a hazard.
   */
  public register(kind: OverlayKind, read: OverlayRectReader): Unsubscribe {
    const token = this.#nextToken;
    this.#nextToken += 1;
    this.#overlaysByToken.set(token, { kind, read });
    this.#changeEmitter.emit();
    return () => {
      if (this.#overlaysByToken.delete(token)) {
        this.#changeEmitter.emit();
      }
    };
  }

  /** Fires when an overlay opens or closes, so a publisher re-samples immediately. */
  public subscribeToChanges(sink: () => void): Unsubscribe {
    return this.#changeEmitter.subscribe(sink);
  }

  /** Every overlay rectangle on screen right now, in registration order. */
  public liveRects(): readonly PaneRect[] {
    const rects: PaneRect[] = [];
    for (const overlay of this.#overlaysByToken.values()) {
      const rect = overlay.read();
      if (rect !== undefined) {
        rects.push(rect);
      }
    }
    return rects;
  }

  /** How many overlays are registered. Read by the pane's own diagnostics. */
  public get registeredCount(): number {
    return this.#overlaysByToken.size;
  }
}

/** One per renderer process, like every other console registry. */
export const consoleOcclusionRegistry: PaneOcclusionRegistry = new PaneOcclusionRegistry();
