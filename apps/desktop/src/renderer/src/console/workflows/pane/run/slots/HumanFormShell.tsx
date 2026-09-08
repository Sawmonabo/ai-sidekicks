// The console's own body for the human-form slot: the phase's form, wired to the
// registered submit.
//
// A FIXTURE SHELL AND NOT THE OWNER'S BODY. `owner-slots.ts` names the workflow
// authoring and execution plan as the author of what finally stands here, and this is
// what the console renders until that arrives — a real form over the schema the run
// read carried, sending the operation the growth ledger already registers. It dies in
// the same PR that mounts the owner's body, exactly as the reserved absence it replaced
// would have: a shell is a shell whether it says "not built yet" or answers a question.
//
// WHAT MAKES IT HONEST RATHER THAN A STUB. Nothing here is composed for effect: the
// prompt and the schema are the wire's, the controls are the form stack's, the submit is
// the registered `workflowHumanFormSubmit` carrying the revision the form was composed
// against, and every refusal is the daemon's or the port's rendered verbatim. Under the
// fixture, which serves the run read and settles no mutation, a press gets the port's
// own typed refusal naming the wire and who owes it — which is the true answer for this
// build and not a simulated success.
//
// THE PORT COMES FROM THE PROVIDER, because the seat gives a body no prop channel: the
// slot mount renders `<Body {...mount} />` and the mount is the OWNER's contract, which
// a console-local port member would widen with a value the owner's body must not be
// handed. `useConsoleBridge` is what the family's pinned progress card already reaches
// for at the same kind of seam, and every console surface renders inside the provider.
//
// AND IT DECIDES NO ELIGIBILITY. Whether this person may answer, whether the phase is
// still waiting, whether the revision is current: all three are the daemon's, reaching
// this surface as a typed refusal beside the control. A stale-revision refusal renders
// the daemon's own sentence as its primary text, because that sentence is the one thing
// that says what happened to the answer somebody had already typed.

import { useConsoleBridge } from "../../../../bridge/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../../../primitives/index.js";
import { HumanPhaseFormAnswer } from "../../../forms/index.js";
import { useHumanFormSubmit } from "../human-form-submit.js";
import type { HumanFormMount } from "./human-form-mount.js";

/**
 * The waiting phase's form, standing in the slot the workflow plan will fill.
 *
 * Props are the mount itself, because that is what a slot body IS — the seat renders it
 * with the mount spread over it, so a body that took a wrapper object would not be one.
 */
export function HumanFormShell(mount: HumanFormMount): React.JSX.Element {
  const bridge = useConsoleBridge();
  const { outcome, submit } = useHumanFormSubmit(bridge.growth, mount);
  return (
    <HumanPhaseFormAnswer prompt={mount.prompt} inputSchema={mount.inputSchema} onSubmit={submit}>
      {renderOutcome(outcome)}
    </HumanPhaseFormAnswer>
  );
}

/**
 * What the port answered the last press, beside the control that made it.
 *
 * A function rather than a second component in this file: it calls no hook and holds no
 * state, and one `.tsx` carries one component. `idle` draws NOTHING and that is not an
 * omission — a control nobody has pressed has no outcome, and an absence primitive there
 * would report on a question that was never put.
 */
function renderOutcome(outcome: ReturnType<typeof useHumanFormSubmit>["outcome"]): React.ReactNode {
  switch (outcome.kind) {
    case "idle":
      return null;
    case "submitting":
      // `not-loaded` and never `computing`: the answer is a round trip that has been put
      // and is still coming, rather than this console working something out.
      return <Nothing kind="not-loaded" placement="inline" title="Waiting for the daemon." />;
    case "submitted":
      return (
        <p className="meridian-schema-answer__settlement">
          <WireFigure value={outcome.submittedAt} />
          <span>
            {outcome.outputCount === 1
              ? "The daemon recorded this answer and one output came of it."
              : `The daemon recorded this answer and ${String(outcome.outputCount)} outputs came of it.`}
          </span>
        </p>
      );
    case "refused":
      return <InlineRefusal code={outcome.refusal.code} detail={outcome.refusal.detail} />;
  }
}
