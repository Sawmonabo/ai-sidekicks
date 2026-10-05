// How an overlay primitive joins the window's airspace.
//
// Registration happens once, at the primitive layer, never per overlay or by hand at a call
// site; this hook is that one site, so a component attaches its ref and does nothing else. It
// arms size observation through `observeElementResize` because the element arrives in its ref
// callback; motion sampling is armed by the native-view consumer through
// `AirspaceRegistry.installMotionObserver`, which keeps a frame loop off a window with no
// native view. The rectangle is read live, never captured: one taken at registration is where
// the overlay was before it opened.
//
// A ref callback rather than an effect over an `isOpen` flag: Base UI unmounts a portal's
// children when its popup closes (`keepMounted` defaults to false), so the element arriving
// is the overlay opening. Most overlays are opened by their own trigger and hold no such
// flag, and minting one would duplicate the library's state. React 19 calls a ref callback's
// returned cleanup on detach and does not call the ref with `null`, so attach and release are
// one closure.

import { useCallback } from "react";

import { airspaceRegistryFor } from "#renderer/lib/airspace/registries.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";

/**
 * What an overlay primitive puts on the element it wants the airspace to yield to.
 *
 * A `ref` value, not a hook result to wire up further: the live rectangle reader, the size
 * arm and the removal all travel with the element, so the only thing a primitive can get
 * wrong is failing to attach it.
 */
export type AirspaceOverlayRef = (element: Element | null) => (() => void) | undefined;

/**
 * Register whatever element is attached as an overlay, for as long as it is mounted.
 *
 * A detached or never-attached element registers nothing. The callback's identity is stable, so a
 * re-render of the primitive does not detach and re-register its popup.
 */
export function useAirspaceRegistration(): AirspaceOverlayRef {
  return useCallback((element: Element | null) => {
    if (element === null) {
      // Reached only if React detaches without honoring the cleanup returned on attach;
      // nothing was registered on that path.
      return undefined;
    }
    const registration = airspaceRegistryFor(element.ownerDocument).register(() => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }, element);
    // Armed here rather than in the registry, and reported through the registration's own
    // `moved` so every change reaches the airspace by one path (a popover positioned after
    // mount, a toast that grows as its text wraps, a dialog that animates in).
    const detachResize = observeElementResize(element, () => {
      registration.moved();
    });
    return () => {
      detachResize();
      registration.remove();
    };
  }, []);
}
