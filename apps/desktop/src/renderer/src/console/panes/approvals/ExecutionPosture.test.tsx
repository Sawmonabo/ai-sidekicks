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
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExecutionPostureChip } from "./ExecutionPosture.js";
import { BROAD_ALLOW_LIST_THRESHOLD } from "./posture-bounds.js";

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
