// What the composer refuses before the wire, and what it says once a composite has
// settled.
//
// The two halves of one rule: a refusal raised here is one the daemon would have
// raised anyway, and a settlement rendered here is one the daemon actually reported.
// Neither invents an outcome, which is why the preview is consent rather than a
// prediction.

import { describe, expect, it } from "vitest";
import { renderComposer, submit, typeInto } from "./run-intervention-composer.test-support.js";
import { RUN_ID } from "../runs-pane.test-support.js";

describe("preview is consent", () => {
  it("shows the scope and the guard before any confirm exists to press", () => {
    const { container } = renderComposer("rollback");
    const preview = container.querySelector(".meridian-run-composer__preview");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain(RUN_ID);
    expect(preview?.textContent).toContain("run version 8");
    expect(preview?.textContent).toContain("paused at the confirmed position");
  });

  it("negative control: the steer arm draws no rewind preview", () => {
    // Without this the case above would pass over a component that rendered the
    // preview unconditionally, which would promise a rewind to somebody steering.
    const { container } = renderComposer("steer");
    expect(container.querySelector(".meridian-run-composer__preview")).toBeNull();
  });
});

describe("the refusals raised before the wire", async () => {
  it("refuses a rewind with no target position, and sends nothing", async () => {
    const { container, calls } = renderComposer("rollback");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("target-position-unnamed");
  });

  it("refuses a target that is not a whole position, and sends nothing", async () => {
    // The prefix parse this replaces read `4oops` as 4 and dispatched a destructive
    // rewind to a position nobody typed.
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4oops");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("target-position-unreadable");
  });

  it("refuses a composite whose replacement is only whitespace, and sends nothing", async () => {
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "   ");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-replacement");
  });

  it("refuses an empty steer, and sends nothing", async () => {
    const { container, calls } = renderComposer("steer");
    await submit(container);
    expect(calls).toHaveLength(0);
    expect(container.textContent).toContain("empty-directive");
  });

  it("negative control: a named position with no replacement dispatches a bare rewind", async () => {
    // Proves the refusals above are about the two named conditions rather than a
    // composer that never sends anything.
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run.intervene");
    expect(calls[0]?.params).toMatchObject({ type: "rollback", targetPosition: 4 });
    expect(calls[0]?.params).not.toHaveProperty("replacementSend");
  });
});

describe("the composite says what it did", () => {
  it("says the replacement is queued and sends on the next resume, never that it was sent", () => {
    const { container } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    const composite = container.querySelector(".meridian-run-composer__composite");
    expect(composite?.textContent).toContain("queued against the run");
    expect(composite?.textContent).toContain("next resume");
    expect(composite?.textContent).not.toContain("re-sent");
  });

  it("queues the replacement byte-identical, indentation and blank line included", async () => {
    // The trim used to run on the way to the wire rather than only on the blank
    // test, so a pasted block reached the queue having lost the shape that was the
    // reason for pasting it. The negative control is the dispatched params: the
    // resolution is the same composite either way.
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), indented);
    await submit(container);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      type: "rollback",
      replacementSend: { content: indented },
    });
  });

  it("carries the replacement on the one intervention rather than as a second call", async () => {
    const { container, calls } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      type: "rollback",
      replacementSend: { content: "try this instead" },
    });
  });
});
