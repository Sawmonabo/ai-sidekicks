// What the steer form refuses before the wire, and what it sends once it does.
//
// A refusal raised here is one the daemon would have raised anyway; it neither invents
// an outcome nor sends a body the user did not write.

import { describe, expect, it } from "vitest";
import { renderSteerBox, submit, typeInto } from "./steer-box.test-support.js";

describe("the refusals raised before the wire", () => {
  it("refuses an empty steer, and sends nothing", async () => {
    const { container, calls } = renderSteerBox();
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-directive");
  });

  it("negative control: a typed steer is dispatched byte-identical", async () => {
    // Proves the refusal above is about the empty body rather than a composer that
    // never sends anything. A trim on the way to the wire would cost a pasted block
    // the shape that was the reason for pasting it.
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    const { container, calls } = renderSteerBox();
    typeInto(container.querySelector(".meridian-run-composer__body"), indented);
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run.intervene");
    expect(calls[0]?.params).toMatchObject({ type: "steer", content: indented });
  });
});
