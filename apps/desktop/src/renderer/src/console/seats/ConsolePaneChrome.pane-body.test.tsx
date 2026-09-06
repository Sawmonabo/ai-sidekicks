// The adapter that narrows one pane-kind body out of the registry's whole context union.
//
// Its own file rather than a fifth suite beside the chrome's, because it is a different
// subject: `ConsolePaneChrome.test.tsx` is about the FRAME a pane wears — its tables, its
// name, its controls, its key claim — and this is about what happens when a body written
// for one kind is handed an address of another. They share a module and nothing else, and
// the two together were past the package's file ceiling.
//
// The claim worth a unit is the DISPOSITION. A mismatch is unreachable through the deck,
// which looks a body up by kind; it is reachable from the two untyped boundaries a restored
// layout row and a typed route are, and there `core/refusal.ts`'s rule is that one bad row
// loses that row rather than the window. So both negative controls are about the disposition
// rather than about the message: that the mismatch arm does not throw, and that the matched
// arm does not refuse.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { paneBodyForKind, type PaneContextOf } from "./ConsolePaneChrome.js";
import { type ConsolePaneContext } from "./pane-context.js";

describe("paneBodyForKind — a mismatched address is refused, not thrown", () => {
  /**
   * A context carrying only what the adapter reads.
   *
   * The adapter compares `context.kind` and hands the whole value on. Building a
   * bridge, a frame store, three persistence stores, and a session store to prove a
   * string comparison would be a fixture testing the fixture, and the cast is what says
   * so out loud rather than hiding behind a builder.
   */
  function addressedAt(kind: ConsolePaneContext["kind"]): ConsolePaneContext {
    return { kind } as unknown as ConsolePaneContext;
  }

  it("renders the body when the address is the kind it was written for", () => {
    const body = paneBodyForKind("runs", () => <p>the runs body</p>);
    const { container } = render(<>{body(addressedAt("runs"))}</>);
    expect(container.textContent).toBe("the runs body");
  });

  it("refuses in place when the address is another kind's", () => {
    const body = paneBodyForKind("runs", () => <p>the runs body</p>);
    const { container } = render(<>{body(addressedAt("diff"))}</>);
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(container.textContent).toContain("pane-composition.pane-kind-mismatch");
    // Named in the words the pane is called everywhere else, and naming what it was
    // actually handed — a refusal that said neither is a refusal nobody can act on.
    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("diff");
  });

  it("negative control: the mismatch arm is a render and not a throw", () => {
    // A throw here would take the whole window down for one bad row in a restored
    // layout, which is the disposition `core/refusal.ts` exists to forbid.
    const body = paneBodyForKind("inspector", () => <p>the inspector body</p>);
    expect(() => body(addressedAt("artifact"))).not.toThrow();
  });

  it("negative control: the matched arm draws no refusal", () => {
    // Without this, "refuses on a mismatch" would also be satisfied by an adapter that
    // refused on everything.
    const body = paneBodyForKind("inspector", () => <p>the inspector body</p>);
    const { container } = render(<>{body(addressedAt("inspector"))}</>);
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("paneBodyForKind — a body takes its own kind's context, not a shape like it", () => {
  // THESE CASES ARE CHECKED BY `tsc`, NOT BY VITEST. The registry stores one render over
  // the whole context union and the adapter narrows it, so a body annotated with a WIDER
  // type than its kind's context is assignable — a parameter is contravariant — and
  // compiles in silence. That is how one pane body came to declare its own props type
  // while its sibling used the seat's, with both green and the seat's contract restated
  // per family. The directives below fail the typecheck the moment the exactness check
  // stops holding, because an unused `@ts-expect-error` is itself an error.

  it("accepts a body annotated with exactly its kind's context", () => {
    const body = paneBodyForKind("inspector", (context: PaneContextOf<"inspector">) => (
      <p>{context.kind}</p>
    ));
    expect(body).toBeTypeOf("function");
  });

  it("accepts a body that declares no parameter, and one that infers it", () => {
    // Ignoring the context is not restating it — there is no second spelling to drift
    // from — and an inline arrow takes its parameter type from the seat by inference,
    // which is the shape most bodies in the tree are written in.
    const ignoring = paneBodyForKind("inspector", () => <p>ignored</p>);
    const inferring = paneBodyForKind("inspector", (context) => <p>{context.kind}</p>);
    expect([ignoring, inferring]).toHaveLength(2);
  });

  it("refuses a body annotated with a subset of its kind's context", () => {
    // The exact shape the finding named: a `Pick` is WIDER than the context — fewer
    // required members means more values satisfy it — so contravariance admits it and
    // only mutual assignability separates "safe" from "the same type".
    const refused = paneBodyForKind(
      "inspector",
      // @ts-expect-error a pane body takes its own kind's context, not a subset of it
      (context: Pick<PaneContextOf<"inspector">, "kind">) => <p>{context.kind}</p>,
    );
    expect(refused).toBeTypeOf("function");
  });

  it("refuses a body annotated with a hand-written props type", () => {
    // The second spelling, which is what actually shipped: a family declares its own
    // interface, it happens to be satisfied by the context, and the seat's contract now
    // has two homes that drift independently.
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
