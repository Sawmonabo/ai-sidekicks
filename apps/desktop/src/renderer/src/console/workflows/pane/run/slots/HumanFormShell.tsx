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
//
// THE FORM IS KEYED BY THE ATTEMPT, AND IT HAS TO BE. A run that branches parks several
// phases on a person at once and the pane mounts ONE form; pressing another park card
// hands this same component a different mount rather than unmounting it, so React
// reconciles the form in place and every state cell inside `useSchemaForm` survives the
// switch. The plan and the validator follow the new schema — they are memoised on it —
// but the drawn answer and the raw JSON do not, so two waits that share a member name
// would show one branch's typed answer under the other's question, and a press would
// record it against the phase now on screen. A key on `phaseRunId` makes the two
// different elements, which is React's own way of saying they are different forms.
//
// `phaseRunId` AND NOT THE PHASE, AND NOT THE REVISION EITHER. The attempt is what the
// answer is composed against and submitted for — a retry mints a new one — so it is the
// finest identity that is still stable while somebody types. `formRevision` moves
// underneath a live form whenever the run read refreshes, and keying on it would throw
// away typing in response to a poll; `phaseId` is the definition's and is reused by
// every attempt at that phase. The submit's own settlement is already held at exactly
// this identity by `useSubjectScopedState`, so both halves of the form's state are
// scoped to one attempt by two mechanisms that agree rather than by one that covers half.

import { useConsoleBridge } from "../../../../bridge/index.js";
import { InlineRefusal, Nothing, WireFigure } from "../../../../primitives/index.js";
import { SchemaFormAnswer } from "../../../../seats/index.js";
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
    <SchemaFormAnswer
      // The header's reason: a switch between two waits reaches this component as a
      // prop change, and only a changed key discards what the previous wait's form held.
      key={mount.phaseRunId}
      prompt={mount.prompt}
      inputSchema={mount.inputSchema}
      onSubmit={submit}
    >
      {renderOutcome(outcome)}
    </SchemaFormAnswer>
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
        // `role="status"` for the reason the workflow-start receipt carries one: the
        // press leaves focus on the submit control, the pending notice this replaces
        // says nothing on its own, and a settlement rendered as an ordinary paragraph
        // is therefore read by everyone who can see the screen and nobody else. The
        // region IS the sentence rather than a wrapper around it, so it speaks when the
        // outcome lands and stays silent through every re-render that does not move it
        // — a second element around this one would be a live region whose content
        // changed for reasons this arm did not.
        <p className="meridian-schema-answer__settlement" role="status">
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
