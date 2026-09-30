// A shell's control move, decoded at the bridge.
//
// A contracts schema is a parser, and every parse of a wire value happens in
// `services/`, so the terminal lease reads what this returns and never the schema.
// The schema's refinements are the point: a take that names no holder, or a release
// that names one, has no trustworthy holder, and the lease line has to treat it as a
// move it could not read rather than guess who holds the shell.

import {
  PtyControlChangedPayloadSchema,
  type PtyControlChangedPayload,
} from "@ai-sidekicks/contracts";

/** Read a `pty.control_changed` payload, or `undefined` where the wire's is off contract. */
export function readPtyControlChangedPayload(
  payload: unknown,
): PtyControlChangedPayload | undefined {
  const parsed = PtyControlChangedPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
