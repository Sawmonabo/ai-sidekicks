// Drives a subject-scoped holder through one committed render without React, in the
// order React would: address during the render, confirm on commit.

import type { SubjectKey, SubjectScopedHolder } from "./subject-scoped-holder.js";

/**
 * Address a holder and confirm it, which is what one committed render does.
 *
 * The React-free call. A suite that called `address` alone would be driving a pass
 * that never reached the screen, and every claim about the visit on screen would be
 * about a proposal instead.
 */
export function visit<TValue>(
  holder: SubjectScopedHolder<TValue>,
  subject: object,
  key: SubjectKey,
  initial: () => TValue,
): void {
  holder.address(subject, key, initial);
  holder.commit(subject, key);
}
