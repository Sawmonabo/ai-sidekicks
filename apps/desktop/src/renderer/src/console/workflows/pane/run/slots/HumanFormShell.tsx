// The console's own fixture body for the human-form slot: the phase's prompt, the
// controls its schema draws, and the one act that sends them.
//
// A FIXTURE SHELL AND NOT THE OWNER'S BODY. `owner-slots.ts` names the workflow
// authoring and execution plan as the author of what finally stands here, and this is
// what the console renders until that arrives. It dies in the same PR that mounts the
// owner's body, exactly as the reserved absence it replaced would have: a shell is a
// shell whether it says "not built yet" or answers a question.
//
// WHICH IS WHY IT IS ONLY THE COMPOSITION. Everything a body could get WRONG is the
// seat's and reaches this component as `mount.submit`: the registered
// `workflowHumanFormSubmit`, the single-flight guard, the revision this attempt was
// composed against, the run read's re-arm, and the rendering of whatever the daemon
// answered are all `HumanFormSubmitChannel.tsx`'s. This file is the shape of the body
// the owner replaces — the prompt, the form over the schema, the act — and nothing else,
// so replacing it is replacing a composition rather than re-implementing a dispatch.
//
// AND IT DECIDES NO ELIGIBILITY. Whether this person may answer, whether the phase is
// still waiting, whether the revision is current: all three are the daemon's, reaching
// the seat as a typed refusal beside the control. Nothing here predicts any of them, and
// nothing here renders one either.
//
// THE ATTEMPT'S KEY IS THE SEAT'S. A switch between two of a branching run's waits
// reaches this component as a prop change rather than an unmount, and only a changed key
// discards what the previous wait's form held. That key is applied where the body is
// mounted, so it holds for the owner's body as well as for this one — see the channel's
// header for why `phaseRunId` and not the phase or the revision.

import { HumanPhaseFormAnswer } from "../../../forms/index.js";
import type { HumanFormMount } from "./human-form-mount.js";

/**
 * The waiting phase's form, standing in the slot the workflow plan will fill.
 *
 * Props are the mount itself, because that is what a slot body IS — the seat renders it
 * with the mount spread over it, so a body that took a wrapper object would not be one.
 */
export function HumanFormShell(mount: HumanFormMount): React.JSX.Element {
  return (
    <HumanPhaseFormAnswer
      prompt={mount.prompt}
      inputSchema={mount.inputSchema}
      // Straight through: the answer this form composed is the whole of what a body
      // knows, and the run, the phase and the revision it travels with are the seat's.
      onSubmit={mount.submit}
    />
  );
}
