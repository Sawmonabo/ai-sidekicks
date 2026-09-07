// What reaches the `action` slot under an artifact refusal: the move, the exclusive
// cases, and the manifests a blocked delete named.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { ArtifactRefusalRecovery, artifactRefusalAction } from "./ArtifactRefusalRecovery.js";
import { artifactRefusalRecovery } from "./artifact-refusal-copy.js";

const REFERENCING_IDS = ["artifact-derivative-1", "artifact-derivative-2"] as const;

describe("ArtifactRefusalRecovery — the copy half", () => {
  it("renders the next move for a code this family answers", () => {
    const recovery = artifactRefusalRecovery("artifact.delete_forbidden");
    const { container } = render(<ArtifactRefusalRecovery recovery={recovery} />);
    expect(container.textContent).toContain("permission answer");
  });

  it("renders the exclusive cases as list items rather than as prose", () => {
    const recovery = artifactRefusalRecovery("artifact.too_large");
    const { container } = render(<ArtifactRefusalRecovery recovery={recovery} />);
    expect(container.querySelectorAll(".meridian-artifact-recovery__cases li")).toHaveLength(3);
  });

  it("negative control: a code with one move grows no empty case list", () => {
    // The list is rendered as a list; an empty `<ul>` under every refusal in the
    // family would be a bullet with nothing in it.
    const recovery = artifactRefusalRecovery("artifact.hash_mismatch");
    const { container } = render(<ArtifactRefusalRecovery recovery={recovery} />);
    expect(container.querySelector(".meridian-artifact-recovery__cases")).toBeNull();
  });
});

describe("ArtifactRefusalRecovery — the manifests a blocked delete named", () => {
  it("renders every id the refusal sent, in the order it sent them", () => {
    const { container } = render(
      <ArtifactRefusalRecovery referencingArtifacts={{ ids: REFERENCING_IDS }} />,
    );
    const items = [
      ...container.querySelectorAll(".meridian-artifact-recovery__referencing-list li"),
    ];
    expect(items.map((item) => item.textContent)).toEqual([...REFERENCING_IDS]);
  });

  it("says the list is partial only where the daemon's total exceeds it", () => {
    // The daemon bounds the list to the first fifty ascending, so a total above the
    // ids is the only reading under which what is on screen is not the whole set.
    const { container } = render(
      <ArtifactRefusalRecovery referencingArtifacts={{ ids: REFERENCING_IDS, total: 51 }} />,
    );
    expect(container.textContent).toContain("The first 2 of 51");
  });

  it("negative control: an agreeing total invents no cap nobody hit", () => {
    const { container } = render(
      <ArtifactRefusalRecovery
        referencingArtifacts={{ ids: REFERENCING_IDS, total: REFERENCING_IDS.length }}
      />,
    );
    expect(container.textContent).not.toContain("The first");
    expect(container.textContent).toContain("Named by the daemon: 2.");
  });
});

describe("artifactRefusalAction — what the slot receives", () => {
  it("composes the move and the list into one answer for a blocked delete", () => {
    const refusal = {
      ...refuse("daemon", "artifact.delete_blocked", "Referenced by 2 manifests."),
      referencingArtifacts: { ids: REFERENCING_IDS, total: 2 },
    };
    const action = artifactRefusalAction(refusal);
    expect(action).toBeDefined();
    const { container } = render(<>{action}</>);
    // ONE ANSWER AND NOT TWO: a remedy naming "the derivatives named below" with
    // nothing below it is the rendering this composition exists to prevent.
    expect(container.textContent).toContain("Delete the derivatives named below first");
    expect(container.textContent).toContain(REFERENCING_IDS[0]);
  });

  it("reads the daemon's refusal through a rejected call's cause", () => {
    // The growth port answers a rejected call with its own `call-rejected`; the
    // daemon's code and its registered extensions ride `cause`.
    const refusal = {
      ...refuse("growth-port", "call-rejected", "artifact CRUD did not answer"),
      cause: {
        ...refuse("daemon", "artifact.delete_blocked", "Referenced by 1 manifest."),
        referencingArtifacts: { ids: [REFERENCING_IDS[0]] },
      },
    };
    const { container } = render(<>{artifactRefusalAction(refusal)}</>);
    expect(container.textContent).toContain("Delete the derivatives named below first");
  });

  it("negative control: a refusal with no move and no list fills the slot with nothing", () => {
    // `undefined` rather than an empty element, so the refusal shape renders without
    // a blank region under the daemon's sentence.
    expect(
      artifactRefusalAction(refuse("growth-port", "wire-unregistered", "Not registered yet.")),
    ).toBeUndefined();
  });
});
