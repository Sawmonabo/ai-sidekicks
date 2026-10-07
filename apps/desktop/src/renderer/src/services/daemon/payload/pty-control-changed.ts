// A shell's control move, decoded at the bridge. Every parse of a wire value happens in
// `services/`, so the terminal lease reads what this returns and never the schema. The schema's
// refinements matter: a take that names no holder, a disconnect that names one, or a release that
// names a run has no trustworthy holder, so the lease treats it as a move it could not read.

import {
  PtyControlChangedPayloadSchema,
  type PtyControlChangedPayload,
} from "@ai-sidekicks/contracts/pty";

/** Read a `pty.control_changed` payload, or `undefined` where the wire's is off contract. */
export function readPtyControlChangedPayload(
  payload: unknown,
): PtyControlChangedPayload | undefined {
  const parsed = PtyControlChangedPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
