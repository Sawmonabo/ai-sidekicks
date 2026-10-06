// Drives a subject-scoped holder through one committed render without React.

import type { SubjectKey, SubjectScopedHolder } from "./holder.js";

/**
 * Addresses a holder and confirms it, as one committed render does. `address` alone would drive a
 * pass that never reached the screen.
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
