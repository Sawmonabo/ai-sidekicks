import { type ExecutionMode } from "@ai-sidekicks/contracts"; // One row of the execution-mode picker, as the picker composes it.
//
// A MODULE OF ITS OWN because the picker builds these rows and the row view draws
// them, so the shape is the seam between the two rather than either one's private
// vocabulary — and a type declared in the parent and imported by the child closes a
// cycle the layering gate refuses.

/** One row, after the reply has been read but before anything is rendered. */
export interface ModeRow {
  readonly mode: ExecutionMode;
  readonly available: boolean;
  /** The daemon's own words for why this mode is unavailable. Never composed here. */
  readonly restrictionReason: string | undefined;
}
