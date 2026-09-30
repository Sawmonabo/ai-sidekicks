// The adapter that narrows one pane-kind body out of the registry's context union. The claim is the
// disposition: a mismatch is reachable only from untyped boundaries (a restored layout row, a typed
// route), and there one bad row must lose that row, not the window. Both negative controls are
// about that: the mismatch arm does not throw, and the matched arm does not refuse.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { paneBodyForKind, type PaneContextOf } from "./pane-body-for-kind.js";
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

  it("negative control: the mismatch arm is a render and not a throw", () => {
    // A throw would take the whole window down for one bad restored row.
    const body = paneBodyForKind("inspector", () => <p>the inspector body</p>);
    expect(() => body(addressedAt("agents"))).not.toThrow();
  });

  it("negative control: the matched arm draws no refusal", () => {
    // Without this, an adapter that refused on everything would pass.
    const body = paneBodyForKind("inspector", () => <p>the inspector body</p>);
    const { container } = render(<>{body(addressedAt("inspector"))}</>);
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("paneBodyForKind — a body takes its own kind's context, not a shape like it", () => {
  // Checked by `tsc`, not vitest: a body annotated with a wider type than its kind's context is
  // assignable (parameters are contravariant) and would compile silently. The directives below
  // fail the typecheck if the exactness check stops holding, since an unused one is an error.

  it("accepts a body annotated with exactly its kind's context", () => {
    const body = paneBodyForKind("inspector", (context: PaneContextOf<"inspector">) => (
      <p>{context.kind}</p>
    ));
    expect(body).toBeTypeOf("function");
  });

  it("accepts a body that declares no parameter, and one that infers it", () => {
    // Ignoring the context restates nothing, and an inline arrow infers its type from the registry.
    const ignoring = paneBodyForKind("inspector", () => <p>ignored</p>);
    const inferring = paneBodyForKind("inspector", (context) => <p>{context.kind}</p>);
    expect([ignoring, inferring]).toHaveLength(2);
  });

  it("refuses a body annotated with a subset of its kind's context", () => {
    // A `Pick` is wider than the context, so contravariance admits it; only mutual assignability
    // rejects it.
    const refused = paneBodyForKind(
      "inspector",
      // @ts-expect-error a pane body takes its own kind's context, not a subset of it
      (context: Pick<PaneContextOf<"inspector">, "kind">) => <p>{context.kind}</p>,
    );
    expect(refused).toBeTypeOf("function");
  });

  it("refuses a body annotated with a hand-written props type", () => {
    // A hand-written interface the context happens to satisfy gives the contract two homes.
    interface InspectorPaneProps {
      readonly kind: "inspector";
    }
    const refused = paneBodyForKind(
      "inspector",
      // @ts-expect-error a pane body takes its own kind's context, not a shape like it
      (context: InspectorPaneProps) => <p>{context.kind}</p>,
    );
    expect(refused).toBeTypeOf("function");
  });
});
