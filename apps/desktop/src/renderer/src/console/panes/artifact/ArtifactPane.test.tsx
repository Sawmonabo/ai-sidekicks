// The artifact pane: its chrome, the absence it renders before a read, and the two
// disclosures §10.4 and §10.8 put at its foot.
//
// The case that matters most is the last one in the first block: `empty` here would be
// the console stating that the session has no artifacts, a fact no read established.
// The second block is about the bounds disclosure, whose whole value is that it names
// WHICH list it is showing — the shipped default and the deployment's effective list
// are different claims and an operator override replaces one with the other wholesale.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
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

  it("offers one re-read control, keyboard-reachable and named", () => {
    const { getByRole } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    expect(getByRole("button", { name: "Read again" })).toBeDefined();
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

describe("artifact pane — the ingest bounds disclosure", () => {
  it("names the shipped default as the default when the effective list is unread", () => {
    const { container } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    const source = container.querySelector(".meridian-ingest-bounds__source");
    expect(source?.textContent).toContain("shipped default");
  });

  it("lists the admitted types and leaves out the scriptable image", () => {
    const { container } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    const types = container.querySelector(".meridian-ingest-bounds__types");
    expect(types?.textContent).toContain("application/pdf");
    expect(types?.textContent).not.toContain("image/svg+xml");
    expect(container.querySelectorAll(".meridian-ingest-bounds__types li")).toHaveLength(
      ATTACHMENT_ALLOWLIST_DEFAULT.length,
    );
  });

  it("names all four bounds a participant can hit", () => {
    const { container } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    const caps = container.querySelector(".meridian-ingest-bounds__caps");
    expect(caps?.textContent).toContain("Per attachment");
    expect(caps?.textContent).toContain("Per carrier");
    expect(caps?.textContent).toContain("Per chunk");
    expect(caps?.textContent).toContain("Per upload");
  });

  it("negative control: the pane offers no visibility toggle", () => {
    // §10.4 names one and `bridge/growth-port.ts` registers no operation for it. A
    // control that could only fail is worse than a control that is not there, and a
    // port entry is not this family's to add.
    const { queryByRole } = render(<ArtifactPane context={contextFor(ARTIFACT_ENTITY)} />);
    expect(queryByRole("button", { name: "Share with the session" })).toBeNull();
    expect(queryByRole("button", { name: "Make local-only" })).toBeNull();
  });
});
