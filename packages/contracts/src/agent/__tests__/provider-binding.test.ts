// A binding switch settles on the held-open request, on the agent row and in two
// events, and each is drawn on screen as it arrives. These cases hold the honesty
// rules those surfaces depend on: a whole conversation declares no loss, a rebuilt
// one declares what it dropped, and an account failure says why the account failed.
import { describe, expect, it } from "vitest";

import {
  AgentBindingSwitchDispositionSchema,
  AgentProviderBindingChangeFailedPayloadSchema,
  AgentProviderBindingChangedPayloadSchema,
} from "../provider-binding.js";
import {
  BINDING_CHANGED_PAYLOAD,
  BINDING_CHANGE_FAILED_PAYLOAD,
  CLAUDE_BINDING,
} from "./provider-binding.test-support.js";

describe("the declared losses of a switch that applied", () => {
  it("accepts a brief that names the summarized history and the private reasoning", () => {
    expect(
      AgentProviderBindingChangedPayloadSchema.safeParse(BINDING_CHANGED_PAYLOAD).success,
    ).toBe(true);
  });

  it("refuses a brief that omits the private reasoning", () => {
    const payload = {
      ...BINDING_CHANGED_PAYLOAD,
      declaredLosses: ["conversation_history_summarized"],
    };
    expect(AgentProviderBindingChangedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses an in-place switch that claims a loss", () => {
    const payload = {
      ...BINDING_CHANGED_PAYLOAD,
      to: { ...CLAUDE_BINDING, effort: "low" },
      landedProviderAccountId: "claude-work",
      continuity: "in_place",
      declaredLosses: ["context_truncated"],
    };
    expect(AgentProviderBindingChangedPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("the account state of a failed switch", () => {
  it("accepts an account failure that names why", () => {
    expect(
      AgentProviderBindingChangeFailedPayloadSchema.safeParse(BINDING_CHANGE_FAILED_PAYLOAD)
        .success,
    ).toBe(true);
  });

  it("refuses an account failure with no state, and a state on another failure", () => {
    const { accountState: _accountState, ...withoutState } = BINDING_CHANGE_FAILED_PAYLOAD;
    expect(AgentProviderBindingChangeFailedPayloadSchema.safeParse(withoutState).success).toBe(
      false,
    );
    expect(
      AgentProviderBindingChangeFailedPayloadSchema.safeParse({
        ...BINDING_CHANGE_FAILED_PAYLOAD,
        reason: "interrupt_refused",
      }).success,
    ).toBe(false);
  });
});

describe("agent.configUpdate's answer", () => {
  it("refuses an applied switch whose conversation did not arrive whole", () => {
    const disposition = {
      status: "applied",
      switchId: "switch-4",
      continuity: "brief",
      declaredLosses: ["conversation_history_summarized", "provider_private_reasoning"],
    };
    expect(AgentBindingSwitchDispositionSchema.safeParse(disposition).success).toBe(false);
  });

  it("refuses a degraded switch that declares nothing on the answer too", () => {
    const disposition = {
      status: "degraded",
      switchId: "switch-5",
      continuity: "brief",
      declaredLosses: [],
    };
    expect(AgentBindingSwitchDispositionSchema.safeParse(disposition).success).toBe(false);
  });

  it("refuses a failed answer whose account state does not match its reason", () => {
    const disposition = { status: "failed", switchId: "switch-6", reason: "account_unavailable" };
    expect(AgentBindingSwitchDispositionSchema.safeParse(disposition).success).toBe(false);
  });
});
