// The primitive layer's one registration site, driven through a real mount.

import { render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "../core/index.js";
import { useAirspaceRegistration } from "./airspace-registration.js";

function OverlayProbe(props: { readonly open: boolean }): React.JSX.Element {
  const popupRef = useRef<HTMLDivElement | null>(null);
  useAirspaceRegistration("dialog", popupRef, props.open);
  return props.open ? <div ref={popupRef} data-testid="popup" /> : <div />;
}

describe("useAirspaceRegistration", () => {
  it("registers an open overlay and removes it on unmount", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(<OverlayProbe open />);
    expect(registry.registeredCount).toBe(before + 1);
    mounted.unmount();
    expect(registry.registeredCount).toBe(before);
  });

  it("registers nothing while the overlay is closed", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(<OverlayProbe open={false} />);
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
  });

  it("registers on open and removes again on close, without remounting", () => {
    const registry = airspaceRegistryFor(document);
    const before = registry.registeredCount;
    const mounted = render(<OverlayProbe open={false} />);
    mounted.rerender(<OverlayProbe open />);
    expect(registry.registeredCount).toBe(before + 1);
    mounted.rerender(<OverlayProbe open={false} />);
    expect(registry.registeredCount).toBe(before);
    mounted.unmount();
  });

  it("reads the element's live rectangle rather than one captured at registration", () => {
    const registry = airspaceRegistryFor(document);
    const mounted = render(<OverlayProbe open />);
    const popup = mounted.getByTestId("popup");
    popup.getBoundingClientRect = () =>
      ({ x: 4, y: 8, width: 120, height: 60 }) as unknown as DOMRect;
    expect(registry.liveRects()).toContainEqual({ x: 4, y: 8, width: 120, height: 60 });
    mounted.unmount();
  });
});
