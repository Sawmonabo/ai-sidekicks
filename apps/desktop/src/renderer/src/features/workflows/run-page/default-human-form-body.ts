// The console's own body for the human-form mount point: the phase's prompt, the form its
// schema draws, and the one act that sends it. The submit call, single-flight guard,
// revision and every eligibility check are the submit channel's and arrive as `mount.submit`.

import { schemaFormAnswerBody } from "../schema-form/schema-form-mounts.js";
import type { HumanFormMount } from "./human-form-mount.js";

/**
 * The waiting phase's form: its prompt, the controls its schema draws, and the submit.
 *
 * Takes the mount itself as props. Rendered through the schema form kit's loader, which
 * fetches the lazy chunk once and holds the loading region.
 */
export function DefaultHumanFormBody(mount: HumanFormMount): React.ReactNode {
  return schemaFormAnswerBody.render({
    prompt: mount.prompt,
    inputSchema: mount.inputSchema,
    // The channel adds the run, phase and revision the answer travels with.
    onSubmit: mount.submit,
  });
}
