// The one arm where the browser answers the chunk request with no.
//
// SEPARATE FROM `PhaseGraph.test.tsx` BECAUSE THE LOADER IS SUBSTITUTED HERE, and that
// file's whole premise is that the loader is the real one. A dynamic import that
// succeeds cannot be made to fail from the outside, so the failure arm is unreachable
// without standing something else in the loader's place — and the substitution is
// file-scoped, so the sibling suite keeps the real fetch it depends on.
//
// WHAT THE REJECTION CARRIES IS THE SUBJECT. A rejected `import()` hands back whatever
// the host chose to reject with, and that is not always an `Error`: the handler used to
// read it with `loadError instanceof Error ? loadError.message : String(loadError)`,
// and both halves of that expression throw on values a rejection may legitimately
// carry. A throw inside a rejection handler escapes as an unhandled rejection, so the
// graph stayed at `loading` forever with nothing on screen saying why — the one failure
// path on this surface, failing.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PhaseGraph } from "./PhaseGraph.js";
import type { PhaseGraphNode } from "./phase-topology.js";

/**
 * What the substituted loader rejects with, settable per case.
 *
 * A box hoisted with the mock rather than a value closed over: `vi.mock` factories are
 * lifted above the imports, so a plain binding is not initialised when the factory
 * runs. The box is read at CALL time, which is what lets one substitution serve every
 * case below.
 */
const chunkRejection = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("./phase-graph-loader.js", () => ({
  phaseGraphLoader: {
    load: (): Promise<never> => Promise.reject(chunkRejection.value),
  },
}));

const TWO_PHASES: readonly PhaseGraphNode[] = [
  {
    phaseId: "plan",
    displayName: "Plan",
    state: "completed",
    gateState: "open",
    parkAttention: undefined,
  },
  {
    phaseId: "build",
    displayName: "Build",
    state: "running",
    gateState: "closed",
    parkAttention: undefined,
  },
];

/** Render with the chunk rejecting on `rejection`, and wait for the arm to settle. */
async function renderRefusedChunk(rejection: unknown): Promise<HTMLElement> {
  chunkRejection.value = rejection;
  const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
  await waitFor(() => {
    expect(container.querySelector(".meridian-refusal--banner")).not.toBeNull();
  });
  const banner = container.querySelector(".meridian-refusal--banner");
  if (!(banner instanceof HTMLElement)) {
    throw new Error("the graph rendered no refusal");
  }
  return banner;
}

describe("a chunk the browser refused", () => {
  it("renders a refusal carrying a code, rather than a bare message", async () => {
    const banner = await renderRefusedChunk(
      new Error("Failed to fetch dynamically imported module"),
    );
    // The seam is in the code, so the failure is quotable; the browser's own sentence
    // is the detail, because what to do next depends on what failed.
    expect(banner.querySelector(".meridian-figure--wire")?.textContent).toBe(
      "phase-graph-chunk-call-failed",
    );
    expect(banner.textContent).toContain("Failed to fetch dynamically imported module");
  });

  it("renders one for a rejection whose prototype cannot be questioned", async () => {
    // A revoked Proxy. The old reading's first half asked `loadError instanceof Error`,
    // which is a proxy trap this value throws from.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const banner = await renderRefusedChunk(revocable.proxy);
    expect(banner.querySelector(".meridian-figure--wire")?.textContent).toBe(
      "phase-graph-chunk-call-failed",
    );
  });

  it("renders one for a rejection that cannot be turned into a string", async () => {
    // A null-prototype object carries no `toString`, so the old reading's second half —
    // `String(loadError)` — ran ToPrimitive and threw.
    const banner = await renderRefusedChunk(Object.create(null) as unknown);
    expect(banner.querySelector(".meridian-figure--wire")?.textContent).toBe(
      "phase-graph-chunk-call-failed",
    );
  });

  it("negative control: both halves of the reading it replaced really do throw", async () => {
    // The finding, asserted rather than described. Without this the three cases above
    // would pass over a surface that had merely changed its markup, and would not name
    // what made the old reading unsafe.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => revocable.proxy instanceof Error).toThrow();
    expect(() => String(Object.create(null) as unknown)).toThrow();
  });

  it("negative control: the banner is not a constant, and no absence stands beside it", async () => {
    // Without this the cases above would be satisfied by a surface that rendered one
    // fixed sentence for every failure — and by one that left the read-in-flight
    // skeleton in the box beside the refusal, which reads as a graph still coming.
    const banner = await renderRefusedChunk(new Error("chunk integrity check failed"));
    expect(banner.textContent).toContain("chunk integrity check failed");
    expect(banner.textContent).not.toContain("Failed to fetch");
    expect(banner.ownerDocument.querySelector(".meridian-nothing")).toBeNull();
  });
});
