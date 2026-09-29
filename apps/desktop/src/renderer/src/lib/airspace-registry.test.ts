// The airspace registry: what it holds, what it emits, and what it never arms.

import { describe, expect, it, vi } from "vitest";

import {
  AIRSPACE_OVERLAY_KINDS,
  AirspaceRegistry,
  type AirspaceMotionObserver,
} from "./airspace-registry.js";

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

/** An element stand-in: the registry only ever hands it to an installed observer. */
function overlayElement(): Element {
  return { nodeType: 1 } as unknown as Element;
}

describe("AirspaceRegistry", () => {
  it("closes the overlay kinds at the seven 12.3 enumerates", () => {
    expect([...AIRSPACE_OVERLAY_KINDS]).toStrictEqual([
      "dialog",
      "popover",
      "context-menu",
      "toast",
      "command-palette",
      "image-lightbox",
      "diagram-lightbox",
    ]);
  });

  it("reads rectangles live rather than capturing them at registration", () => {
    const registry = new AirspaceRegistry();
    let top = 0;
    registry.register("dialog", () => rect(0, top, 100, 40));
    expect(registry.liveRects()).toStrictEqual([rect(0, 0, 100, 40)]);
    top = 120;
    expect(registry.liveRects()).toStrictEqual([rect(0, 120, 100, 40)]);
  });

  it("drops an overlay whose reader answers nothing, and keeps the rest", () => {
    const registry = new AirspaceRegistry();
    registry.register("toast", () => undefined);
    registry.register("popover", () => rect(1, 2, 3, 4));
    expect(registry.liveRects()).toStrictEqual([rect(1, 2, 3, 4)]);
    expect(registry.registeredCount).toBe(2);
  });

  it("emits on register, on moved, and on remove", () => {
    const registry = new AirspaceRegistry();
    const changes = vi.fn();
    registry.subscribeToChanges(changes);
    const registration = registry.register("context-menu", () => rect(0, 0, 10, 10));
    expect(changes).toHaveBeenCalledTimes(1);
    registration.moved();
    expect(changes).toHaveBeenCalledTimes(2);
    registration.remove();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("is idempotent on remove and silent on moved afterwards", () => {
    const registry = new AirspaceRegistry();
    const changes = vi.fn();
    const registration = registry.register("dialog", () => rect(0, 0, 10, 10));
    registry.subscribeToChanges(changes);
    registration.remove();
    registration.remove();
    registration.moved();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(registry.registeredCount).toBe(0);
  });

  it("observes nothing at all until a consumer installs an observer", () => {
    // The idle-CPU claim, checked rather than promised: an overlay registered into a
    // window that is drawing no native view arms no frame source of any kind.
    const registry = new AirspaceRegistry();
    registry.register("dialog", () => rect(0, 0, 10, 10), overlayElement());
    expect(registry.observedOverlayCount).toBe(0);
  });

  it("arms the overlays already registered and every later one, and disarms on uninstall", () => {
    const registry = new AirspaceRegistry();
    const disarm = vi.fn();
    const observe: AirspaceMotionObserver = vi.fn(() => disarm);
    const early = registry.register("dialog", () => rect(0, 0, 10, 10), overlayElement());
    const uninstall = registry.installMotionObserver(observe);
    expect(registry.observedOverlayCount).toBe(1);
    registry.register("popover", () => rect(0, 0, 10, 10), overlayElement());
    expect(registry.observedOverlayCount).toBe(2);
    early.remove();
    expect(disarm).toHaveBeenCalledTimes(1);
    uninstall();
    expect(registry.observedOverlayCount).toBe(0);
    expect(disarm).toHaveBeenCalledTimes(2);
  });

  it("does not arm an overlay that registered no element", () => {
    const registry = new AirspaceRegistry();
    const observe: AirspaceMotionObserver = vi.fn(() => () => undefined);
    registry.register("toast", () => rect(0, 0, 10, 10));
    registry.installMotionObserver(observe);
    expect(observe).not.toHaveBeenCalled();
    expect(registry.observedOverlayCount).toBe(0);
  });

  it("reports an installed observer's own movement as a change", () => {
    const registry = new AirspaceRegistry();
    let reportMoved: (() => void) | undefined;
    registry.installMotionObserver((_element, onMoved) => {
      reportMoved = onMoved;
      return () => undefined;
    });
    const changes = vi.fn();
    registry.register("dialog", () => rect(0, 0, 10, 10), overlayElement());
    registry.subscribeToChanges(changes);
    reportMoved?.();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("installs one observer identity once", () => {
    // A second install would overwrite the first arming's disarm and leave it live
    // after an uninstall — the leak the identity check exists to prevent.
    const registry = new AirspaceRegistry();
    const observe: AirspaceMotionObserver = vi.fn(() => () => undefined);
    registry.register("dialog", () => rect(0, 0, 10, 10), overlayElement());
    registry.installMotionObserver(observe);
    registry.installMotionObserver(observe);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(registry.observedOverlayCount).toBe(1);
  });
});
