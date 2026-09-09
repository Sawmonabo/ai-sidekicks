// A surface mount reads the partitions a person's window would have.
//
// THE DEFECT THIS PINS. `SessionStore` takes its projector table at construction, and
// the approvals mount built one from `registerApprovalFlowProjectors` alone. So the
// `approval` partition folded and the `run` partition stayed empty — and
// `ApprovalsPaneBody` reads the run each pending decision names out of that second
// partition to render the boundary it executed under. It found nothing, rendered the
// chip's ABSENT arm, and both tiers that mount this surface passed: the accessibility
// tier because an absence is as auditable as a chip, the screenshot tier because it
// minted that frame as the committed reference. The reference was a picture of a state
// the fixture does not describe — `APPROVALS_SCENARIO` stamps a posture on its own
// `run.running` beat. `surfaces/projector-composition.ts` is the fix and review is what
// keeps it, but neither of those says what a person then sees, and that is this file.
//
// WHY THE CLAIM IS MADE HERE. The mounts are browser-mode modules —
// `console-harness.tsx` imports `vitest/browser` for the CDP and user-event seams the
// three browser tiers share — so no happy-dom project can drive one, and the two tiers
// that already do are an audit and a capture rather than an assertion about content.
// This tier is where a mounted tree is asserted on directly.
//
// THE ASSERTION IS THE ONE A PERSON MAKES. `.meridian-posture--stamped` is the reading
// class `ExecutionPostureChip` composes from `reading="stamped"`, and it is present on
// exactly the arm that has a posture to render — the absent arm renders a `Nothing`
// badge carrying no `.meridian-posture` element at all. Both halves are asserted over
// one mount, because a pane rendering BOTH would satisfy a presence claim while telling
// a person two contradictory things about one run.
//
// AND THE MODE IS READ OUT OF THE SCENARIO rather than spelled here. A literal would
// agree with the fixture by discipline alone, and the day the scenario's posture
// changed this case would go on asserting a boundary nothing stamps.

import { afterEach, describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";
import { mountApprovalsPane } from "../surfaces/composer.js";

import { APPROVALS_SCENARIO } from "../../../src/renderer/src/console/bridge/scenario/approvals/approvals.js";
import { ExecutionPostureChip } from "../../../src/renderer/src/console/primitives/index.js";

/** The reading class the chip composes when it HAS a posture to show. */
const STAMPED_POSTURE_SELECTOR = ".meridian-posture--stamped";

/** What the chip says instead when the run it was asked about carries none. */
const ABSENT_POSTURE_TITLE = "Execution boundary unknown";

/**
 * The sandbox mode the approvals scenario stamps, read off the beat that stamps it.
 *
 * A throw rather than a fallback: a scenario that stopped stamping a posture would make
 * the assertion below vacuous, and the message names what went missing.
 */
function stampedPostureMode(): string {
  const stamping = APPROVALS_SCENARIO.beats.find((beat) => beat.event.kind === "run.running");
  const posture = stamping?.event.payload?.["executionPosture"];
  const mode =
    typeof posture === "object" && posture !== null
      ? (posture as Record<string, unknown>)["mode"]
      : undefined;
  if (typeof mode !== "string") {
    throw new Error("the approvals scenario stamps no execution posture on its `run.running` beat");
  }
  return mode;
}

afterEach(() => {
  // The mounts append their own container to the document, so a later case would read a
  // tree an earlier one left behind.
  document.body.replaceChildren();
});

describe("the approvals surface renders the boundary its scenario stamps", () => {
  it("renders one stamped posture carrying the fixture's mode, and no absent arm", async () => {
    const mounted = await mountApprovalsPane();

    const stamped = [...mounted.element.querySelectorAll(STAMPED_POSTURE_SELECTOR)];
    // ONE, and not merely at least one: `addressedRunPostures` deduplicates the runs
    // its pending decisions name, and this scenario's two pending requests were raised
    // by one run. A count claim is what catches a fold projecting a run per request.
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.textContent).toContain(stampedPostureMode());
    expect(mounted.element.textContent).not.toContain(ABSENT_POSTURE_TITLE);
  });

  it("negative control: an unstamped run renders the arm this case says is gone", async () => {
    // Without it, both halves above are also the answer a selector matching nothing and
    // a text search finding nothing would give. Driven through the REAL chip on the one
    // input that produces the failing reading, so what is shown is that the two
    // instruments separate the two states rather than that either says no to everything.
    const { container } = await renderSettled(
      <ExecutionPostureChip posture={undefined} reading="stamped" />,
    );

    expect(container.querySelector(STAMPED_POSTURE_SELECTOR)).toBeNull();
    expect(container.textContent).toContain(ABSENT_POSTURE_TITLE);
  });
});
