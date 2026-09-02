// Which controls exist, and what the two apply actions actually submit.
//
// The load-bearing case is the one where a capability is NOT declared: the control
// is absent, never disabled, because a disabled control asserts that the operation
// exists and is momentarily unavailable — and the daemon would refuse it outright.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../core/index.js";
import { ProviderSwitch } from "./ProviderSwitch.js";
import { DRIVER_CATALOG_FIXTURE } from "./driver-catalog-fixtures.js";
import type { AgentRosterEntry } from "./agent-wire.js";
import type { DriverCatalogReading } from "./driver-catalog.js";
import type { PushDrivenReadState } from "../collaboration/push-driven-read.js";

const LOADED: PushDrivenReadState<DriverCatalogReading> = {
  kind: "loaded",
  value: DRIVER_CATALOG_FIXTURE,
};

const ON_CLAUDE: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
};

const ON_CODEX: AgentRosterEntry = { ...ON_CLAUDE, driverName: "codex", modelId: "gpt-5.6" };

function fieldLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".meridian-axis-field__label")].map(
    (element) => element.textContent ?? "",
  );
}

/** Edits one axis through the plain text input, which needs no popup to open. */
function editProviderAccount(container: HTMLElement, value: string): void {
  const input = container.querySelector(".meridian-axis-field__text");
  fireEvent.change(input as HTMLInputElement, { target: { value } });
}

describe("provider switch — before the vocabularies are known", () => {
  it("names the read that is in flight and offers no axis to set", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={{ kind: "not-loaded" }} onApply={() => {}} />,
    );
    expect(container.textContent ?? "").toContain("Reading what this agent may be moved to");
    expect(container.querySelector(".meridian-axis-field")).toBeNull();
  });

  it("renders the refusal rather than an empty form", () => {
    const { container } = render(
      <ProviderSwitch
        agent={ON_CLAUDE}
        catalog={{ kind: "failed", refusal: refuse("driver-catalog", "read-failed", "no route") }}
        onApply={() => {}}
      />,
    );
    expect(container.textContent ?? "").toContain("no route");
    expect(container.querySelector(".meridian-axis-field")).toBeNull();
  });
});

describe("provider switch — an undeclared capability has no control at all", () => {
  it("omits the output-speed control for a driver that declares no speed axis", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CODEX} catalog={LOADED} onApply={() => {}} />,
    );
    expect(fieldLabels(container)).not.toContain("Output speed");
    // Absent, not disabled — the whole point of the rule.
    expect(container.querySelector("[disabled]")).toBeNull();
  });

  it("negative control: the declaring driver does get that control", () => {
    // Without this, the case above would pass over a form that never drew the axis
    // for anyone, which would hide a real regression rather than prove the rule.
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    expect(fieldLabels(container)).toContain("Output speed");
  });

  it("always offers the driver axis, which is gated by no flag", () => {
    for (const agent of [ON_CLAUDE, ON_CODEX]) {
      const { container } = render(
        <ProviderSwitch agent={agent} catalog={LOADED} onApply={() => {}} />,
      );
      expect(fieldLabels(container)).toContain("Driver");
    }
  });
});

describe("provider switch — the consequences are stated before the action is offered", () => {
  it("offers no apply action until an axis has actually been edited", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    expect(container.querySelectorAll(".meridian-switch__apply").length).toBe(0);
    expect(container.textContent ?? "").not.toContain("prompt cache");
  });

  it("states the cache loss and names the pending switch it would displace", () => {
    const { container } = render(
      <ProviderSwitch
        agent={{
          ...ON_CLAUDE,
          pendingSwitch: {
            switchId: "switch-7",
            appliesAt: "run_boundary",
            interruptRequested: false,
            pendingAxes: [{ axis: "effort", value: "low" }],
          },
        }}
        catalog={LOADED}
        onApply={() => {}}
      />,
    );
    editProviderAccount(container, "account-2");
    const text = container.textContent ?? "";
    expect(text).toContain("prompt cache");
    expect(text).toContain("switch-7");
    expect(container.querySelectorAll(".meridian-switch__apply").length).toBe(2);
  });

  it("negative control: with nothing pending it claims to displace nothing", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    editProviderAccount(container, "account-2");
    expect(container.textContent ?? "").toContain("prompt cache");
    expect(container.textContent ?? "").not.toContain("supersedes the switch already pending");
  });
});

describe("provider switch — what each apply action submits", () => {
  it("submits the edited axes and no interrupt on the deferred action", () => {
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    editProviderAccount(container, "account-2");
    const [deferred] = [...container.querySelectorAll(".meridian-switch__apply")];
    fireEvent.click(deferred as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ providerAccountId: "account-2" }, false);
  });

  it("negative control: the second action carries the interrupt flag instead", () => {
    // Two actions that submitted the same flag would make one of them a lie about
    // when the switch lands.
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    editProviderAccount(container, "account-2");
    const actions = [...container.querySelectorAll(".meridian-switch__apply")];
    fireEvent.click(actions[1] as HTMLButtonElement);
    expect(onApply).toHaveBeenCalledWith({ providerAccountId: "account-2" }, true);
  });

  it("drops an axis cleared back to empty rather than submitting a blank value", () => {
    const onApply = vi.fn();
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={onApply} />,
    );
    editProviderAccount(container, "account-2");
    editProviderAccount(container, "");
    expect(container.querySelectorAll(".meridian-switch__apply").length).toBe(0);
  });
});

describe("provider switch — the settlement rides the reply", () => {
  it("renders the settlement it was handed", () => {
    const { container } = render(
      <ProviderSwitch
        agent={ON_CLAUDE}
        catalog={LOADED}
        onApply={() => {}}
        settlement={{
          status: "applied",
          continuity: "memo",
          declaredLosses: ["context_truncated"],
        }}
      />,
    );
    expect(container.textContent ?? "").toContain("switched");
  });

  it("negative control: no settlement renders no settlement line", () => {
    const { container } = render(
      <ProviderSwitch agent={ON_CLAUDE} catalog={LOADED} onApply={() => {}} />,
    );
    expect(container.querySelector(".meridian-settlement")).toBeNull();
  });
});
