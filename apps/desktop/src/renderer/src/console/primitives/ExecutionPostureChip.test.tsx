// The execution boundary: five absences, each one asserted.
//
// This component's whole contract is what it declines to say. Absence is not
// `trusted`, an empty writable-roots list means two opposite things depending on
// the mode beside it, a credential policy is a reference and never an expansion,
// and a broad allow-list is never presented as safety. Each case below fails if
// the corresponding line of code stops being absent.
//
// The posture type is imported from `@ai-sidekicks/contracts`, so these fixtures
// are the registered wire shape rather than a local restatement of it — a change
// to the contract's cross-field invariants is a compile error here.

import { type ExecutionPosture } from "@ai-sidekicks/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExecutionPostureChip } from "./ExecutionPostureChip.js";
import { BROAD_ALLOW_LIST_THRESHOLD } from "../core/index.js";

const TRUSTED: ExecutionPosture = {
  mode: "trusted",
  networkAccess: "full",
  writableRoots: [],
};

const SANDBOXED: ExecutionPosture = {
  mode: "readonly-sandboxed",
  networkAccess: "none",
  writableRoots: [],
  credentialPolicyRef: "policy/default-deny",
};

describe("an absent posture is unknown, never trusted", () => {
  it("names the absence and what it is not", () => {
    render(<ExecutionPostureChip posture={undefined} reading="stamped" />);
    expect(screen.getByText("Execution boundary unknown")).not.toBeNull();
  });

  it("negative control: it renders no mode at all, least of all the permissive one", () => {
    // The failure this guards is a component that defaulted an absent posture to
    // the most permissive mode, which would read on screen exactly like a real one.
    const { container } = render(<ExecutionPostureChip posture={undefined} reading="stamped" />);
    expect(container.querySelector(".meridian-chip")).toBeNull();
    expect(screen.queryByText("trusted")).toBeNull();
  });
});

describe("writable roots are never shown without their mode", () => {
  it("says an empty list under a sandboxed mode means nothing is writable", () => {
    render(<ExecutionPostureChip posture={SANDBOXED} reading="stamped" />);
    expect(screen.getByText(/nothing is writable under this mode/u)).not.toBeNull();
  });

  it("says an empty list under trusted means no OS-enforced constraint", () => {
    // The same empty array, the opposite fact. A single sentence for both would be
    // wrong in one of the two cases and unfalsifiable in this test.
    render(<ExecutionPostureChip posture={TRUSTED} reading="stamped" />);
    expect(screen.getByText(/no OS-enforced write constraint/u)).not.toBeNull();
    expect(screen.queryByText(/nothing is writable under this mode/u)).toBeNull();
  });

  it("lists the roots verbatim when there are any", () => {
    render(
      <ExecutionPostureChip
        posture={{ ...SANDBOXED, writableRoots: ["/repo/src", "/tmp/scratch"] }}
        reading="stamped"
      />,
    );
    expect(screen.getByText("/repo/src")).not.toBeNull();
    expect(screen.getByText("/tmp/scratch")).not.toBeNull();
  });
});

describe("the network axis", () => {
  it("shows allowed domains only under the mode that has them", () => {
    render(<ExecutionPostureChip posture={SANDBOXED} reading="stamped" />);
    expect(screen.queryByText("Allowed domains")).toBeNull();
  });

  it("lists them, and warns where the list is broad", () => {
    const domains = Array.from(
      { length: BROAD_ALLOW_LIST_THRESHOLD },
      (_unused, index) => `host-${String(index)}.example`,
    );
    render(
      <ExecutionPostureChip
        posture={{
          mode: "workspace-sandboxed",
          networkAccess: "allowed-domains",
          allowedDomains: [domains[0] ?? "host.example", ...domains.slice(1)],
          writableRoots: ["/repo"],
          credentialPolicyRef: "policy/scoped",
        }}
        reading="stamped"
      />,
    );
    expect(screen.getByText("Allowed domains")).not.toBeNull();
    expect(screen.getByText(/domain fronting/u)).not.toBeNull();
  });

  it("negative control: a narrow allow-list carries no such warning", () => {
    render(
      <ExecutionPostureChip
        posture={{
          mode: "workspace-sandboxed",
          networkAccess: "allowed-domains",
          allowedDomains: ["api.example"],
          writableRoots: ["/repo"],
          credentialPolicyRef: "policy/scoped",
        }}
        reading="stamped"
      />,
    );
    expect(screen.getByText("api.example")).not.toBeNull();
    expect(screen.queryByText(/domain fronting/u)).toBeNull();
  });
});

describe("the credential policy is a reference", () => {
  it("shows the ref itself on a sandboxed mode", () => {
    render(<ExecutionPostureChip posture={SANDBOXED} reading="stamped" />);
    expect(screen.getByText("policy/default-deny")).not.toBeNull();
  });

  it("renders no credential row under trusted, where the contract forbids one", () => {
    render(<ExecutionPostureChip posture={TRUSTED} reading="stamped" />);
    expect(screen.queryByText("Credential policy")).toBeNull();
  });
});

describe("a stamped boundary and an intended one are visibly different", () => {
  it("marks an intent as an intent, and says which run it is not", () => {
    const { container } = render(<ExecutionPostureChip posture={TRUSTED} reading="intent" />);
    expect(container.querySelector(".meridian-posture--intent")).not.toBeNull();
    expect(screen.getByText(/not a stamped boundary/u)).not.toBeNull();
  });

  it("negative control: a stamped reading claims neither", () => {
    const { container } = render(<ExecutionPostureChip posture={TRUSTED} reading="stamped" />);
    expect(container.querySelector(".meridian-posture--intent")).toBeNull();
    expect(screen.queryByText(/not a stamped boundary/u)).toBeNull();
  });
});

describe("no composite security score", () => {
  it("renders the axes independently and never a single level", () => {
    const { container } = render(<ExecutionPostureChip posture={SANDBOXED} reading="stamped" />);
    const chipLabels = [...container.querySelectorAll(".meridian-chip__label")].map(
      (label) => label.textContent,
    );
    // Exactly the two axes the wire carries — a third chip here would be a score
    // this component fabricated from them.
    expect(chipLabels).toStrictEqual(["readonly-sandboxed", "none"]);
    expect(screen.getByText(/does not imply uniform enforcement/u)).not.toBeNull();
  });
});

describe("the row density shows the mode and the roots together, never one alone", () => {
  const WRITABLE: ExecutionPosture = {
    mode: "workspace-sandboxed",
    networkAccess: "none",
    writableRoots: ["/Users/dev/code/one", "/Users/dev/code/two"],
    credentialPolicyRef: "policy/default-deny",
  };

  it("summarises the writable roots beside the mode while closed", () => {
    // The rule this holds: `writableRoots` never appears without its `mode`,
    // because an empty list means two opposite things. At row density the list is
    // summarised rather than dropped, so the pair is never split.
    render(<ExecutionPostureChip posture={WRITABLE} reading="stamped" presentation="row" />);
    expect(screen.getByText("workspace-sandboxed")).not.toBeNull();
    expect(screen.getByText("2 writable")).not.toBeNull();
  });

  it("says which of the two empty-list readings applies, from the mode beside it", () => {
    render(<ExecutionPostureChip posture={SANDBOXED} reading="stamped" presentation="row" />);
    expect(screen.getByText("nothing writable")).not.toBeNull();

    render(<ExecutionPostureChip posture={TRUSTED} reading="stamped" presentation="row" />);
    expect(screen.getByText("no writable root recorded")).not.toBeNull();
  });

  it("builds no definition list until a reader opens it", () => {
    // A list of runs carries one of these per row. A closed `<details>` hides its
    // children without stopping React from building them, so the density claim is
    // paid for by rendering nothing rather than by hiding it.
    const { container } = render(
      <ExecutionPostureChip posture={WRITABLE} reading="stamped" presentation="row" />,
    );
    expect(container.querySelector(".meridian-posture__facts")).toBeNull();

    const disclosure = container.querySelector("details");
    if (disclosure === null) {
      throw new Error("the row presentation rendered no disclosure to open");
    }
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(container.querySelector(".meridian-posture__facts")).not.toBeNull();
    expect(screen.getByText("/Users/dev/code/one")).not.toBeNull();
  });

  it("negative control: the card density opens every fact without being asked", () => {
    const { container } = render(<ExecutionPostureChip posture={WRITABLE} reading="stamped" />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".meridian-posture__facts")).not.toBeNull();
  });

  it("renders the same facts at both densities, so the row drops no member", () => {
    // The row is a presentation and never a subset: both arms render one
    // `PostureFacts`, and this is the case that fails if one of them grows a
    // shorter copy.
    const card = render(<ExecutionPostureChip posture={WRITABLE} reading="stamped" />);
    const cardTerms = [...card.container.querySelectorAll("dt")].map((term) => term.textContent);

    const row = render(
      <ExecutionPostureChip posture={WRITABLE} reading="stamped" presentation="row" />,
    );
    const disclosure = row.container.querySelector("details");
    if (disclosure === null) {
      throw new Error("the row presentation rendered no disclosure to open");
    }
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    const rowTerms = [...row.container.querySelectorAll("dt")].map((term) => term.textContent);

    expect(rowTerms).toStrictEqual(cardTerms);
  });
});
