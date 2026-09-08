// What one press actually puts on the wire, over the schema the phase declared.
//
// THE REQUEST AND NOT THE HOOK. The claim under test is the composed
// `workflowHumanFormSubmit` — every member of it, read off the port the console really
// dispatches through — so the cases render the slot, answer the controls the mapper drew,
// and read the request out of the probe. A case that called the hook and asserted its
// return would say nothing about what the daemon receives, which is the whole subject.
//
// AND THE SCHEMA IS THE REAL ONE. The attachment carrier is composed from the phase's own
// input schema — not from what the form drew over it — so a carrier written by hand here
// would assert an order this file chose rather than the order an author declared.
//
// WHAT IS DELIBERATELY NOT HERE. The arms the slot opens on, the single-flight refusal,
// the settlement rendering, and the re-armed run read are `slots/HumanFormShell.test.tsx`
// and its siblings. These cases are only about the request.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  bridgeWatchingSubmits,
  fixtureWaitMount,
  pressSubmit,
  renderSlot,
} from "./slots/HumanFormShell.test-support.js";
import { settle } from "../../workflows-probe.test-support.js";

afterEach(() => {
  cleanup();
});

/**
 * A phase asking for two artifacts either side of an ordinary answer.
 *
 * TWO artifact members and not one: with a single one, a carrier built from the answer's
 * own key order and a carrier built from the schema's declared order are the same list,
 * and the case would pass over either.
 */
const TWO_ARTIFACTS_SCHEMA = {
  type: "object",
  properties: {
    design: { type: "string", format: "artifact", title: "Design" },
    summary: { type: "string", title: "Summary" },
    evidence: { type: "string", format: "artifact", title: "Evidence" },
  },
} as const;

/** Type one drawn control's value, addressed the way a person reaches it. */
function answer(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Answer this phase's controls and press its one act, settling what the press started. */
async function submitAnswered(
  answers: readonly (readonly [string, string])[],
): Promise<ReturnType<typeof bridgeWatchingSubmits>> {
  const probe = bridgeWatchingSubmits();
  renderSlot({ ...fixtureWaitMount(), inputSchema: TWO_ARTIFACTS_SCHEMA }, probe.bridge);
  for (const [label, value] of answers) {
    answer(label, value);
  }
  await act(async () => {
    pressSubmit();
  });
  await settle();
  return probe;
}

describe("the submitted request carries artifact answers through the attachment carrier", () => {
  it("lists the answered artifact and keeps its keyed value in the fields", async () => {
    const probe = await submitAnswered([
      ["Evidence", "artifact-evidence-7"],
      ["Summary", "signed off"],
    ]);

    // The carrier is what the attachment rules read: without it the daemon has a string
    // in a record and no way to persist it as an artifact reference or to report it
    // unresolved in its declared position.
    expect(probe.requests.at(0)?.attachmentArtifactIds).toStrictEqual(["artifact-evidence-7"]);
    // And the keyed value stays exactly where the schema asked for it, because that is
    // the answer the phase's own schema is checked against.
    expect(probe.requests.at(0)?.fields).toStrictEqual({
      summary: "signed off",
      evidence: "artifact-evidence-7",
    });
  });

  it("lists both artifacts in the order the schema declares them, not the order answered", async () => {
    const probe = await submitAnswered([
      ["Evidence", "artifact-evidence-7"],
      ["Design", "artifact-design-2"],
    ]);

    expect(probe.requests.at(0)?.attachmentArtifactIds).toStrictEqual([
      "artifact-design-2",
      "artifact-evidence-7",
    ]);
  });

  it("omits the carrier where the phase asks for no artifact at all", async () => {
    // Absent rather than empty: the wire declares the member optional for exactly this
    // case, and an empty list would answer a question this phase never put.
    const probe = bridgeWatchingSubmits();
    renderSlot(fixtureWaitMount(), probe.bridge);
    await act(async () => {
      pressSubmit();
    });
    await settle();

    expect(probe.requests).toHaveLength(1);
    expect(probe.requests.at(0)).not.toHaveProperty("attachmentArtifactIds");
  });

  it("negative control: an unanswered artifact member contributes nothing to the carrier", async () => {
    // Without this, the two cases above would pass over a carrier that simply listed
    // every artifact member the schema declared, answered or not.
    const probe = await submitAnswered([["Summary", "nothing attached"]]);

    expect(probe.requests.at(0)?.fields).toStrictEqual({ summary: "nothing attached" });
    expect(probe.requests.at(0)).not.toHaveProperty("attachmentArtifactIds");
  });
});
