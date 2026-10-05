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

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "device-laptop";
const CLAUDE_BINDING = {
  driverName: "claude",
  modelId: "opus",
  providerAccountId: "claude-work",
  effort: "high",
} as const;
const CODEX_BINDING = {
  driverName: "codex",
  modelId: "gpt-5.5",
  providerAccountId: "codex-personal",
  effort: "medium",
} as const;

const CHANGED = {
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  switchId: "switch-1",
  actor: DEVICE_ID,
  from: CLAUDE_BINDING,
  to: CODEX_BINDING,
  landedProviderAccountId: "codex-personal",
  continuity: "brief",
  declaredLosses: ["conversation_history_summarized", "provider_private_reasoning"],
} as const;

const FAILED = {
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  switchId: "switch-2",
  actor: DEVICE_ID,
  from: CLAUDE_BINDING,
  attempted: { driverName: "codex", modelId: "gpt-5.5" },
  reason: "account_unavailable",
  accountState: "reauth_required",
} as const;

describe("the declared losses of a switch that applied", () => {
  it("accepts a brief that names the summarized history and the private reasoning", () => {
    expect(AgentProviderBindingChangedPayloadSchema.safeParse(CHANGED).success).toBe(true);
  });

  it("refuses a brief that omits the private reasoning", () => {
    const payload = { ...CHANGED, declaredLosses: ["conversation_history_summarized"] };
    expect(AgentProviderBindingChangedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses an in-place switch that claims a loss", () => {
    const payload = {
      ...CHANGED,
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
    expect(AgentProviderBindingChangeFailedPayloadSchema.safeParse(FAILED).success).toBe(true);
  });

  it("refuses an account failure with no state, and a state on another failure", () => {
    const { accountState: _accountState, ...withoutState } = FAILED;
    expect(AgentProviderBindingChangeFailedPayloadSchema.safeParse(withoutState).success).toBe(
      false,
    );
    expect(
      AgentProviderBindingChangeFailedPayloadSchema.safeParse({
        ...FAILED,
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
