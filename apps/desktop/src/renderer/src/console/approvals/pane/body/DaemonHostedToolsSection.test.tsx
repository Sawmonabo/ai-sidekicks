// The section is present exactly where the capability is, and a refused read is not
// an absence.
//
// Two findings meet here. `CallbackTools` makes the feature ABSENT for a driver that
// declares no `callback_tools`, and a wrapper written outside it went on rendering the
// heading over nothing — reporting a registry surface where the capability contract
// says none exists. And a refused capability read declares nothing, so every flag on
// it reads `unknown`: rendering that reading said "the driver's flags have not been
// read" while throwing away the code and sentence the daemon gave for why.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { type CallbackToolRegistryReading } from "../posture/callback-tool-registry.js";
import { DaemonHostedToolsSection } from "./DaemonHostedToolsSection.js";

const HEADING = "Daemon-hosted tools";

const EXPOSED: CallbackToolRegistryReading = {
  kind: "exposed",
  tools: [
    {
      name: "approval_request",
      description: "Ask a person to approve an action.",
      inputSchema: { type: "object", properties: { category: { type: "string" } } },
    },
  ],
};

describe("the section is gated on the capability, not only its body", () => {
  it("renders no heading at all for a driver that declares no registry", () => {
    // The finding: `CallbackTools` returned `null` and the wrapper stayed, so the
    // surface reported a registry that exists and holds nothing.
    const { container } = render(
      <DaemonHostedToolsSection
        capability="undeclared"
        readRefusal={undefined}
        registry={EXPOSED}
      />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
  });

  it("negative control: a declared capability renders the section and its body", () => {
    // Without this the case above would pass over a component that rendered nothing
    // for every reading there is.
    render(
      <DaemonHostedToolsSection capability="declared" readRefusal={undefined} registry={EXPOSED} />,
    );
    expect(screen.getByRole("region", { name: HEADING })).not.toBeNull();
    expect(screen.getByText("approval_request")).not.toBeNull();
  });
});

describe("a refused capability read keeps the daemon's answer", () => {
  it("renders the code and detail instead of the generic unread absence", () => {
    // A refused readout declares nothing, so the flag reads `unknown` — and the
    // generic sentence for `unknown` drops the one thing an operator can act on.
    render(
      <DaemonHostedToolsSection
        capability="unknown"
        readRefusal={refuse("bridge", "session.not_found", "No session with that id is open.")}
        registry={EXPOSED}
      />,
    );
    expect(screen.getByText("session.not_found")).not.toBeNull();
    expect(screen.getByText("No session with that id is open.")).not.toBeNull();
    expect(
      screen.queryByText("The bound driver's capability flags have not been read."),
    ).toBeNull();
  });

  it("keeps the section standing even where the flag reads as an absence", () => {
    // A read that failed declares nothing, which is not the same claim as a driver
    // that declared the capability absent — so a refusal may never be withdrawn into
    // the `undeclared` arm's silence.
    render(
      <DaemonHostedToolsSection
        capability="undeclared"
        readRefusal={refuse("bridge", "reply-unscripted", "No scripted reply for that call.")}
        registry={undefined}
      />,
    );
    expect(screen.getByRole("region", { name: HEADING })).not.toBeNull();
    expect(screen.getByText("reply-unscripted")).not.toBeNull();
  });
});
