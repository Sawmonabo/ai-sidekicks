// The states that must never collapse: no driver registry, an unread capability, an unsettled
// read, and a withheld registry all differ, and an exposed-but-empty registry would read like
// a withheld one if merged. Capability and registry are separate props because they come
// from separate reads.

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CALLBACK_TOOLS_CAPABILITY, CallbackTools } from "./CallbackTools.js";
import { type CallbackToolRegistryReading } from "../callback-tool-registry.js";

const TOOL: SessionCallbackTool = {
  name: "approval_request",
  description: "Ask a person to approve an action.",
  inputSchema: { category: "string", resourceDescriptor: "string" },
};

function withheld(tools: readonly SessionCallbackTool[]): CallbackToolRegistryReading {
  return { kind: "withheld", tools };
}

function exposed(tools: readonly SessionCallbackTool[]): CallbackToolRegistryReading {
  return { kind: "exposed", tools };
}

describe("the capability gate", () => {
  it("pins the flag to the registered union", () => {
    // A literal, not an inferred string: the constant's annotation makes a contracts-side
    // rename a compile error, and this asserts the value it admits.
    expect(CALLBACK_TOOLS_CAPABILITY).toBe("callback_tools");
  });

  it("renders nothing at all when the driver declares no registry", () => {
    const { container } = render(<CallbackTools capability="undeclared" registry={exposed([])} />);
    // Absent, not empty: a heading over an empty list would report a registry that exists and
    // holds nothing.
    expect(container.innerHTML).toBe("");
  });

  it("negative control: a declared capability renders a body", () => {
    const { container } = render(
      <CallbackTools capability="declared" registry={exposed([TOOL])} />,
    );
    expect(container.innerHTML).not.toBe("");
  });
});

describe("an unread capability is not an empty registry", () => {
  it("says the driver's flags have not been read", () => {
    render(<CallbackTools capability="unknown" registry={exposed([])} />);
    expect(
      screen.getByText("The bound driver's capability flags have not been read."),
    ).not.toBeNull();
  });

  it("negative control: an unread capability lists nothing it might have assembled", () => {
    // Guards against synthesizing the registry from tool rows already seen, which would list
    // only tools already called.
    render(<CallbackTools capability="unknown" registry={exposed([TOOL])} />);
    expect(screen.queryByText("approval_request")).toBeNull();
  });
});

describe("a registry read that has not settled is neither withheld nor empty", () => {
  it("says the read is in flight rather than showing a list", () => {
    render(<CallbackTools capability="declared" registry={undefined} />);
    expect(
      screen.getByText("Reading the registry of tools the background service hosts."),
    ).not.toBeNull();
    expect(screen.queryByText(/The registry is withheld/u)).toBeNull();
  });
});

describe("withheld is not empty either", () => {
  it("says withheld, names the backstop, and never says none are registered", () => {
    render(<CallbackTools capability="declared" registry={withheld([])} />);
    expect(screen.getByText(/The registry is withheld/u)).not.toBeNull();
  });

  it("renders the born-withheld entry as denied", () => {
    const { container } = render(
      <CallbackTools capability="declared" registry={withheld([TOOL])} />,
    );
    expect(screen.getByText("approval_request")).not.toBeNull();
    // The chip on the row, not the paragraph's word: the row is what says the entry is
    // unreachable.
    const chipLabels = [...container.querySelectorAll(".meridian-chip__label")].map(
      (label) => label.textContent,
    );
    expect(chipLabels).toStrictEqual(["denied"]);
  });

  it("distinguishes an exposed empty registry from a withheld one", () => {
    render(<CallbackTools capability="declared" registry={exposed([])} />);
    expect(screen.queryByText(/The registry is withheld/u)).toBeNull();
    expect(screen.getByText(/constructed and trusted by the background service/u)).not.toBeNull();
  });
});

describe("an exposed registry", () => {
  it("names each tool and its governance, and never calls it a provider tool", () => {
    render(<CallbackTools capability="declared" registry={exposed([TOOL])} />);
    expect(screen.getByText("approval_request")).not.toBeNull();
    expect(screen.getByText("Ask a person to approve an action.")).not.toBeNull();
    expect(screen.getByText("background service")).not.toBeNull();
    expect(screen.getByText(/none of them bypasses the approval pipeline/u)).not.toBeNull();
  });

  it("offers the input schema behind a disclosure rather than in the row", () => {
    render(<CallbackTools capability="declared" registry={exposed([TOOL])} />);
    const trigger = screen.getByRole("button", { name: "Input schema" });
    expect(trigger).not.toBeNull();
    // Closed by default: the row stays one line.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
