// The adapter that narrows one pane-kind body out of the registry's context union. The claim is the
// disposition: a mismatch is reachable only from untyped boundaries (a restored layout row, a typed
// route), and there one bad row must lose that row, not the window.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { paneBodyForKind } from "./pane-body-for-kind.js";
import { type PaneContext } from "./pane-context.js";

describe("paneBodyForKind — a mismatched address is refused, not thrown", () => {
  /**
   * A context carrying only `kind`, which is all the adapter reads; a full builder would test the
   * fixture.
   */
  function addressedAt(kind: PaneContext["kind"]): PaneContext {
    return { kind } as unknown as PaneContext;
  }

  it("renders the body when the address is the kind it was written for", () => {
    const body = paneBodyForKind("terminal", () => <p>the terminal body</p>);
    const { container } = render(<>{body(addressedAt("terminal"))}</>);
    expect(container.textContent).toBe("the terminal body");
  });

  it("refuses in place when the address is another kind's", () => {
    const body = paneBodyForKind("terminal", () => <p>the terminal body</p>);
    const { container } = render(<>{body(addressedAt("diff"))}</>);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(container.textContent).toContain("pane-composition.pane-kind-mismatch");
    // The refusal must name the pane's title and the address it was handed.
    expect(container.textContent).toContain("Terminal");
    expect(container.textContent).toContain("diff");
  });
});
