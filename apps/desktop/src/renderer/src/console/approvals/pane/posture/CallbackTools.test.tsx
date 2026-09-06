// Four states that must never collapse into each other.
//
// "No driver hosts a registry", "this build has not read the driver's flags",
// "nothing answered the registry read", and "the registry is withheld" are four
// different facts with four different next moves — and the fifth, an exposed
// registry that happens to be empty, reads identically to the withheld one unless
// the component keeps them apart. Each case below is the one that fails when two of
// them merge.
//
// The capability and the registry are separate props because they are separate
// reads: the flag comes from `driver.listCapabilities` and the entries from the
// growth port, so the cases pair them independently rather than deriving one.

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type ConsoleRefusal } from "../../../core/index.js";
import { CALLBACK_TOOLS_CAPABILITY, CallbackTools } from "./CallbackTools.js";
import { type CallbackToolRegistryReading } from "./callback-tool-registry.js";

const TOOL: SessionCallbackTool = {
  name: "approval_request",
  description: "Ask a person to approve an action.",
  inputSchema: { category: "string", resourceDescriptor: "string" },
};

/** The refusal both bridges answer the registry read with today. */
const NO_WIRE: ConsoleRefusal = {
  code: "wire-unregistered",
  detail: "No registry-read method exists in the wire contract.",
  origin: "growth-port",
};

function withheld(tools: readonly SessionCallbackTool[]): CallbackToolRegistryReading {
  return { kind: "withheld", tools, unreadRefusal: NO_WIRE };
}

function exposed(tools: readonly SessionCallbackTool[]): CallbackToolRegistryReading {
  return { kind: "exposed", tools };
}

describe("the capability gate", () => {
  it("pins the flag to the registered union", () => {
    // A literal here rather than an inferred string is the point: the annotation on
    // the constant makes a contracts-side rename a compile error, and this asserts
    // the value that annotation admits.
    expect(CALLBACK_TOOLS_CAPABILITY).toBe("callback_tools");
  });

  it("renders nothing at all when the driver declares no registry", () => {
    const { container } = render(<CallbackTools capability="undeclared" registry={exposed([])} />);
    // Absent, not empty: a heading over an empty list would report a registry that
    // exists and holds nothing, which is a different claim about the driver.
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
    // The failure this guards is a component that synthesised the registry from
    // tool rows it had seen, which would list only tools already called.
    render(<CallbackTools capability="unknown" registry={exposed([TOOL])} />);
    expect(screen.queryByText("approval_request")).toBeNull();
  });
});

describe("a registry read that has not settled is neither withheld nor empty", () => {
  it("says the read is in flight rather than showing a list", () => {
    render(<CallbackTools capability="declared" registry={undefined} />);
    expect(screen.getByText("Reading the daemon-hosted tool registry.")).not.toBeNull();
    expect(screen.queryByText(/The registry is withheld/u)).toBeNull();
  });
});

describe("withheld is not empty either", () => {
  it("says withheld, names the backstop, and never says none are registered", () => {
    render(<CallbackTools capability="declared" registry={withheld([])} />);
    expect(screen.getByText(/The registry is withheld/u)).not.toBeNull();
  });

  it("renders the born-withheld entry as denied, with the missing read named beside it", () => {
    const { container } = render(
      <CallbackTools capability="declared" registry={withheld([TOOL])} />,
    );
    expect(screen.getByText("approval_request")).not.toBeNull();
    // The chip on the ROW, not the word in the paragraph above it: the entry is
    // registered and unreachable, and the row is what says so.
    const chipLabels = [...container.querySelectorAll(".meridian-chip__label")].map(
      (label) => label.textContent,
    );
    expect(chipLabels).toStrictEqual(["denied"]);
    // The read this surface put, carried as its own refusal rather than folded into
    // the withholding sentence: one says no wire answered, the other says spawn does
    // not expose these tools, and the two are different claims.
    expect(screen.getByText("wire-unregistered")).not.toBeNull();
  });

  it("distinguishes an exposed empty registry from a withheld one", () => {
    render(<CallbackTools capability="declared" registry={exposed([])} />);
    expect(screen.queryByText(/The registry is withheld/u)).toBeNull();
    expect(screen.getByText(/constructed and trusted by the daemon/u)).not.toBeNull();
  });
});

describe("a read that failed is neither withheld nor exposed", () => {
  it("renders the refusal rather than a registry", () => {
    render(
      <CallbackTools
        capability="declared"
        registry={{
          kind: "unread",
          refusal: { code: "call-rejected", detail: "It did not answer.", origin: "growth-port" },
        }}
      />,
    );
    expect(screen.getByText("call-rejected")).not.toBeNull();
    expect(screen.queryByText(/The registry is withheld/u)).toBeNull();
    expect(screen.queryByText(/constructed and trusted by the daemon/u)).toBeNull();
  });
});

describe("an exposed registry", () => {
  it("names each tool and its governance, and never calls it a provider tool", () => {
    render(<CallbackTools capability="declared" registry={exposed([TOOL])} />);
    expect(screen.getByText("approval_request")).not.toBeNull();
    expect(screen.getByText("Ask a person to approve an action.")).not.toBeNull();
    expect(screen.getByText("daemon-hosted")).not.toBeNull();
    expect(screen.getByText(/none of them bypasses the approval pipeline/u)).not.toBeNull();
  });

  it("offers the input schema behind a disclosure rather than in the row", () => {
    render(<CallbackTools capability="declared" registry={exposed([TOOL])} />);
    const trigger = screen.getByRole("button", { name: "Input schema" });
    expect(trigger).not.toBeNull();
    // Closed by default — the row stays one line, and the schema is available to a
    // reader who asks for it rather than spent on everyone who does not.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
