// The arm where the browser refuses the chunk request. The loader is substituted here, so this
// is separate from `RunGraph.test.tsx`, which needs the real one. A rejection need not be an
// `Error`, and reading it with `instanceof` or `String()` throws on some values, which would
// leave the graph at `loading` with nothing on screen saying why.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunGraph } from "./RunGraph.js";
import type { RunGraphNode } from "./phase-topology.js";

/**
 * What the substituted loader rejects with, settable per case.
 *
 * Hoisted with the mock because `vi.mock` factories run above the imports; read at call time
 * so one substitution serves every case.
 */
const chunkRejection = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("./run-graph-loader.js", () => ({
  runGraphLoader: {
    load: (): Promise<never> => Promise.reject(chunkRejection.value),
  },
}));

const TWO_PHASES: readonly RunGraphNode[] = [
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
  const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
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
    // The seam is in the code so the failure is quotable; the browser's own sentence is the
    // detail, since what to do next depends on what failed.
    expect(banner.querySelector(".meridian-figure--wire")?.textContent).toBe(
      "run-graph-chunk-call-failed",
    );
    expect(banner.textContent).toContain("Failed to fetch dynamically imported module");
  });

  it("renders one for a rejection whose prototype cannot be questioned", async () => {
    // A revoked Proxy: asking `instanceof Error` is a proxy trap this value throws from.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const banner = await renderRefusedChunk(revocable.proxy);
    expect(banner.querySelector(".meridian-figure--wire")?.textContent).toBe(
      "run-graph-chunk-call-failed",
    );
  });

  it("renders one for a rejection that cannot be turned into a string", async () => {
    // A null-prototype object has no `toString`, so `String(loadError)` throws in ToPrimitive.
    const banner = await renderRefusedChunk(Object.create(null) as unknown);
    expect(banner.querySelector(".meridian-figure--wire")?.textContent).toBe(
      "run-graph-chunk-call-failed",
    );
  });

  it("negative control: both halves of the reading it replaced really do throw", async () => {
    // Asserts that both halves of the old reading throw, so the cases above cannot pass over
    // a component that only changed its markup.
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => revocable.proxy instanceof Error).toThrow();
    expect(() => String(Object.create(null) as unknown)).toThrow();
  });

  it("negative control: the banner is not a constant, and no absence stands beside it", async () => {
    // Without this, a component rendering one fixed sentence would pass, as would one that
    // left the read-in-flight skeleton beside the refusal.
    const banner = await renderRefusedChunk(new Error("chunk integrity check failed"));
    expect(banner.textContent).toContain("chunk integrity check failed");
    expect(banner.textContent).not.toContain("Failed to fetch");
    expect(banner.ownerDocument.querySelector(".meridian-nothing")).toBeNull();
  });
});
