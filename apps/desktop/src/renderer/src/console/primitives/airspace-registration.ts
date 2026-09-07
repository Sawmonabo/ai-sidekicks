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

import { useEffect } from "react";

import { airspaceRegistryFor, type AirspaceOverlayKind } from "../core/index.js";
import { observeElementResize } from "./element-resize.js";

/**
 * Register one overlay element in its own window's airspace for the life of a mount.
 *
 * The ref is read in the effect rather than taken as an element, because a primitive
 * hands its popup element over on commit and has none during the render that asks for
 * the registration. A ref holding `null` — a popup that is closed, or a portal that
 * has not landed — registers nothing, which is the correct reading of an overlay that
 * is not on screen.
 */
export function useAirspaceRegistration(
  kind: AirspaceOverlayKind,
  elementRef: React.RefObject<Element | null>,
  isOpen: boolean,
): void {
  useEffect(() => {
    const element = elementRef.current;
    if (!isOpen || element === null) {
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
  }, [elementRef, isOpen, kind]);
}
