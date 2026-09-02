// The artifact pane's chrome, and the conflation it is held away from.
//
// The pane claims a kind whose body is not built, which is the state `Spec-023`
// calls reserved rather than missing — so the cases below check that the frame is
// a named region a person can find, that the artifact it is a view of arrives
// wire-verbatim and recoverable, and that the absence in the body is the one that
// says nobody asked. The last is the one that matters: `empty` here would be the
// console stating that the session has no artifacts, a fact no read established.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type ConsolePaneContext } from "../../workspace/index.js";
import { ArtifactPane } from "./ArtifactPane.js";

/**
 * A pane context whose collaborators are never reached — `legacy-surfaces.test.ts`'s
 * cast, for its reason: the assertions are about what the address renders as.
 */
function contextFor(entity: ConsolePaneContext["entity"]): ConsolePaneContext {
  return { kind: "artifact", entity, paneId: "pane-artifact-1" } as unknown as ConsolePaneContext;
}

const ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-diff-01" } as const;

describe("artifact pane — chrome", () => {
  it("names itself as a region", () => {
    const { getByRole } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    expect(getByRole("region", { name: "Artifact" })).toBeDefined();
  });

  it("renders the subject verbatim, with the full string recoverable", () => {
    const { container } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(ARTIFACT_ENTITY.id);
    expect(subject?.getAttribute("title")).toBe(ARTIFACT_ENTITY.id);
  });

  it("negative control: a pane with no entity renders no subject", () => {
    // Without this, the case above would pass over a chrome that rendered the
    // subject slot unconditionally with an empty string in it.
    const { container } = render(<ArtifactPane context={contextFor(undefined)} />);
    expect(container.querySelector(".meridian-repos-pane__subject")).toBeNull();
  });
});

describe("artifact pane — the absence it renders", () => {
  it("says the question was not put, on a surface", () => {
    const { container } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: it is not the empty shape", () => {
    // `empty` would assert that the session's artifact read came back with none.
    // Nothing has been read, and the two absences render as different shapes.
    const { container } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});
