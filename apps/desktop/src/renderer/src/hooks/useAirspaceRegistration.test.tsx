// The one airspace registration site, driven through a real mount.
//
// The hook registers what is attached and releases it on detach, so opening an overlay puts its
// rectangle in the airspace and closing it takes exactly that back out. Only a mount can see the
// ref reach the element. `OverlayPopups.airspace.test.tsx` owns what each primitive registers.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "#renderer/lib/airspace/registries.js";
import { useAirspaceRegistration } from "./useAirspaceRegistration.js";

function OverlayProbe(props: { readonly open: boolean }): React.JSX.Element {
  const airspaceRef = useAirspaceRegistration();
  return props.open ? <div ref={airspaceRef} data-testid="popup" /> : <div />;
}

describe("useAirspaceRegistration", () => {
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
