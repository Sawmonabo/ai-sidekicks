// The console's own body for the human-form mount point: the phase's prompt, the controls its
// schema draws, and the one act that sends them.
//
// IT IS ONLY THE COMPOSITION. Everything a body could get WRONG is the channel's and reaches
// this component as `mount.submit`: the submit call, the single-flight guard, the revision
// this attempt was composed against, the run read's re-arm, and the rendering of whatever
// the daemon answered are all `HumanFormSubmitBinding.tsx`'s. This file is the shape of a
// body — the prompt, the form over the schema, the act — and nothing else, so a supplied body
// replaces a composition rather than re-implementing a dispatch.
//
// AND IT DECIDES NO ELIGIBILITY. Whether this person may answer, whether the phase is
// still waiting, whether the revision is current: all three are the daemon's, reaching
// the channel as a typed refusal beside the control. Nothing here predicts any of them, and
// nothing here renders one either.
//
// THE ATTEMPT'S KEY IS THE CHANNEL'S. A switch between two of a branching run's waits
// reaches this component as a prop change rather than an unmount, and only a changed key
// discards what the previous wait's form held. That key is applied where the body is
// mounted, so it holds for a supplied body as well as for this one — see the channel's
// header for why `phaseRunId` and not the phase or the revision.

import { schemaFormAnswerBody } from "@renderer/console/seats/index.js";
import type { HumanFormMount } from "./human-form-mount.js";

/**
 * The waiting phase's form: its prompt, the controls its schema draws, and the submit.
 *
 * Props are the mount itself, because that is what a mount point body IS — the channel renders it
 * with the mount spread over it, so a body that took a wrapper object would not be one.
 *
 * MOUNTED THROUGH `schemaFormAnswerBody`'S LOADER AND NOT AS AN ELEMENT, because the schema
 * form kit is its own chunk: that loader-backed body holds the single in-flight load and
 * the reserved region a form leaves while its module is arriving, so this composition
 * gains no loading state of its own and the chunk is fetched once however many forms ask.
 */
export function DefaultHumanFormBody(mount: HumanFormMount): React.ReactNode {
  return schemaFormAnswerBody.render({
    prompt: mount.prompt,
    inputSchema: mount.inputSchema,
    // Straight through: the answer this form composed is the whole of what a body
    // knows, and the run, the phase and the revision it travels with are the channel's.
    onSubmit: mount.submit,
  });
}
