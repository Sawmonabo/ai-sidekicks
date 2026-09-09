// The door's loader resolves a body, and the body is the form.
//
// TWO CLAIMS THE TYPES CANNOT MAKE ON THEIR OWN. That the specifier the door writes
// resolves to a real module in a real bundler run — a `LazyBodyLoader` annotation
// checks the SHAPE of what the promise settles with and says nothing about whether the
// path exists — and that the resolved `Body` renders the switch over the context it was
// handed rather than over anything of its own.
//
// DRIVEN THROUGH THE DOOR, because the door is what a second family reaches. A suite
// that imported the body module directly would prove the module renders and leave the
// one line a host actually writes unchecked.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { loadProviderSwitchBody, type ProviderSwitchBodyContext } from "../index.js";
import { LOADED, ON_CLAUDE, fieldLabels } from "./provider-switch.test-support.js";

/** A context over the shared fixtures, with whatever the case is about layered on. */
function context(overrides: Partial<ProviderSwitchBodyContext> = {}): ProviderSwitchBodyContext {
  return { agent: ON_CLAUDE, catalog: LOADED, onApply: () => {}, ...overrides };
}

describe("the provider switch reaches a second family as a loaded chunk", () => {
  it("resolves a module exporting `Body` under the name the seat contract fixes", async () => {
    const module = await loadProviderSwitchBody();

    expect(typeof module.Body).toBe("function");
  });

  it("renders the switch over the context it is handed", async () => {
    const { Body } = await loadProviderSwitchBody();

    const { container } = render(<>{Body(context())}</>);

    expect(container.querySelector(".meridian-switch")).not.toBeNull();
    // The axes the form draws, which is what proves the CONTEXT arrived: every one of
    // them is read off the catalog and the agent this case handed over.
    expect(fieldLabels(container)).toStrictEqual([
      "Driver",
      "Model",
      "Effort",
      "Output speed",
      "Provider account",
    ]);
  });

  it("negative control: a refused catalog renders that refusal and no form at all", async () => {
    // Without this the case above would pass over a body that rendered the same form
    // whatever it was handed — which is exactly what a context dropped on the way
    // through would look like from the outside.
    const { Body } = await loadProviderSwitchBody();

    const { container } = render(
      <>
        {Body(
          context({
            catalog: {
              kind: "failed",
              refusal: refuse("driver-catalog", "read-failed", "no route"),
            },
          }),
        )}
      </>,
    );

    expect(container.textContent ?? "").toContain("no route");
    expect(container.querySelector(".meridian-axis-field")).toBeNull();
  });
});
