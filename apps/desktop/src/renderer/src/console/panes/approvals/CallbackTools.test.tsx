// Three states that must never collapse into each other.
//
// "No driver hosts a registry", "nobody has read the registry", and "the registry
// is withheld" are three different facts with three different next moves, and the
// fourth — an exposed registry that happens to be empty — reads identically to the
// third unless the component keeps them apart. Each case below is the one that
// fails when two of them merge.

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CALLBACK_TOOLS_CAPABILITY, CallbackTools } from "./CallbackTools.js";

const TOOL: SessionCallbackTool = {
  name: "approval_request",
  description: "Ask a person to approve an action.",
  inputSchema: { category: "string", resourceDescriptor: "string" },
};

describe("the capability gate", () => {
  it("pins the flag to the registered union", () => {
    // A literal here rather than an inferred string is the point: the annotation on
    // the constant makes a contracts-side rename a compile error, and this asserts
    // the value that annotation admits.
    expect(CALLBACK_TOOLS_CAPABILITY).toBe("callback_tools");
  });

  it("renders nothing at all when the driver declares no registry", () => {
    const { container } = render(
      <CallbackTools capability="undeclared" isWithheld={false} tools={[]} />,
    );
    // Absent, not empty: a heading over an empty list would report a registry that
    // exists and holds nothing, which is a different claim about the driver.
    expect(container.innerHTML).toBe("");
  });

  it("negative control: a declared capability renders a body", () => {
    const { container } = render(
      <CallbackTools capability="declared" isWithheld={false} tools={[TOOL]} />,
    );
    expect(container.innerHTML).not.toBe("");
  });
});

describe("unread is not empty", () => {
  it("says the registry has not been read, and why no read exists", () => {
    render(<CallbackTools capability={undefined} isWithheld={false} tools={[]} />);
    expect(screen.getByText("The daemon-hosted tool registry has not been read.")).not.toBeNull();
    expect(screen.getByText(/No registry-read method exists/u)).not.toBeNull();
  });

  it("negative control: an unread state lists nothing it might have assembled", () => {
    // The failure this guards is a component that synthesised the registry from
    // tool rows it had seen, which would list only tools already called.
    render(<CallbackTools capability={undefined} isWithheld={false} tools={[TOOL]} />);
    expect(screen.queryByText("approval_request")).toBeNull();
  });
});

describe("withheld is not empty either", () => {
  it("says withheld, names the backstop, and never says none are registered", () => {
    render(<CallbackTools capability="declared" isWithheld tools={[]} />);
    expect(screen.getByText(/The registry is withheld/u)).not.toBeNull();
    expect(screen.getByText("denied")).not.toBeNull();
  });

  it("distinguishes an exposed empty registry from a withheld one", () => {
    render(<CallbackTools capability="declared" isWithheld={false} tools={[]} />);
    expect(screen.queryByText(/The registry is withheld/u)).toBeNull();
    expect(screen.getByText(/constructed and trusted by the daemon/u)).not.toBeNull();
  });
});

describe("an exposed registry", () => {
  it("names each tool and its governance, and never calls it a provider tool", () => {
    render(<CallbackTools capability="declared" isWithheld={false} tools={[TOOL]} />);
    expect(screen.getByText("approval_request")).not.toBeNull();
    expect(screen.getByText("Ask a person to approve an action.")).not.toBeNull();
    expect(screen.getByText("daemon-hosted")).not.toBeNull();
    expect(screen.getByText(/none of them bypasses the approval pipeline/u)).not.toBeNull();
  });

  it("offers the input schema behind a disclosure rather than in the row", () => {
    render(<CallbackTools capability="declared" isWithheld={false} tools={[TOOL]} />);
    const trigger = screen.getByRole("button", { name: "Input schema" });
    expect(trigger).not.toBeNull();
    // Closed by default — the row stays one line, and the schema is available to a
    // reader who asks for it rather than spent on everyone who does not.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
