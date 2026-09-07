// How an overlay primitive joins the window's airspace.
//
// `Spec-023 §Console Design (Meridian)` 12.3: "Registration happens once, at the
// primitive layer, never per overlay instance", and its Never bullet: "No consumer
// registers an overlay by hand at a call site." This hook is the primitive layer's
// half of both — one registration site the overlay primitives share, so a surface
// that opens a dialog says which KIND of overlay it is and nothing else.
//
// THE REGISTRY IS `core/`'s AND THE OBSERVATION IS NOT. The set lives at the DAG
// floor so this family can reach it at all; the size observation is armed here,
// through the console's one `ResizeObserver` chokepoint, because that chokepoint is
// this family's module and `core/` may not import it. Motion sampling — an overlay
// carried across the screen with its box unchanged — is armed by the native-view
// consumer through `AirspaceRegistry.installMotionObserver`, which is what keeps a
// frame loop off a window that is drawing no native view.
//
// THE RECTANGLE IS READ LIVE, never captured. A rectangle taken at registration is
// where the overlay was before it opened, and a view that yielded to it would yield
// to a box that has moved.
//
// A REF CALLBACK AND NOT AN EFFECT OVER AN `isOpen` FLAG, which is the shape that lets
// the primitives own this rather than the surfaces above them. Base UI unmounts a
// portal's children when its popup closes (`keepMounted` defaults to false on every
// family), so the element ARRIVING is the overlay opening and the element leaving is
// it closing — the one fact a wrapper already holds. An effect keyed on an `isOpen`
// argument needed that flag threaded in from wherever the open state lived, and four
// of the console's five overlay families are opened by their own trigger and hold no
// such flag anywhere: the wrappers would have had to mint one and keep it in step with
// the library's, which is a second source of truth for whether an overlay is on
// screen. React 19 calls a ref callback's returned cleanup on detach and then does not
// call the ref with `null`, so attach and release are one closure and neither can be
// forgotten by a caller that never sees them.

import { useCallback } from "react";

import { airspaceRegistryFor, type AirspaceOverlayKind } from "../core/index.js";
import { observeElementResize } from "./element-resize.js";

/**
 * What an overlay primitive puts on the element it wants the airspace to yield to.
 *
 * A `ref` value and not a hook result a caller has to wire up further: the whole
 * registration — the live rectangle reader, the size arm, and the removal — travels
 * with the element, so the only thing a primitive can get wrong is failing to attach
 * it, which the architecture gate is what catches.
 */
export type AirspaceOverlayRef = (element: Element | null) => (() => void) | undefined;

/**
 * Register whatever element is attached as an overlay of `kind`, for as long as it is
 * mounted.
 *
 * A detached or never-attached element registers nothing, which is the correct reading
 * of an overlay that is not on screen. The callback's identity is stable per kind, so
 * a re-render of the primitive does not detach and re-register the popup it is holding.
 */
export function useAirspaceRegistration(kind: AirspaceOverlayKind): AirspaceOverlayRef {
  return useCallback(
    (element: Element | null) => {
      if (element === null) {
        // Reached only if React ever detaches without honouring the cleanup this
        // returns on every attach. Nothing was registered on that path, so nothing
        // is released here.
        return undefined;
      }
      const registration = airspaceRegistryFor(element.ownerDocument).register(
        kind,
        () => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        },
        element,
      );
      // The size seam is armed here rather than inside the registry, and it reports
      // through the registration's own `moved` so every change reaches the airspace by
      // one path. A popover positioned after mount, a toast that grows as its text
      // wraps, and a dialog that animates in are all this arm.
      const detachResize = observeElementResize(element, () => {
        registration.moved();
      });
      return () => {
        detachResize();
        registration.remove();
      };
    },
    [kind],
  );
}
