import { useSubjectScopedResource } from "./subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedTerminalDisposal } from "#renderer/lib/subject-scoped/disposal.js";
import { ReadScope } from "#renderer/lib/reads/scope.js";
import { type SubjectKey } from "#renderer/lib/subject-scoped/holder.js";

/** Mint one scope per read line. A module-level function, so the holder gets a stable identity. */
function openReadScope(): ReadScope {
  return new ReadScope();
}

/**
 * The disposal a scope has: terminal, with `isClosed` beside it.
 *
 * React's double mount abandons the scope in the committed cleanup and re-runs the effect
 * against it; without `isClosed` the component would keep reading through a line that can
 * never open a live round again.
 */
const READ_SCOPE_DISPOSAL: SubjectScopedTerminalDisposal<ReadScope> = {
  dispose: (scope: ReadScope): void => {
    scope.abandon();
  },
  isClosed: (scope: ReadScope): boolean => scope.isAbandoned,
};

/**
 * Hold one read line per `(subject, key)`, and end it however its render ended.
 *
 * `useSubjectScopedResource` owns the lifetime (scopes from discarded renders, subjects that
 * moved, double mounts), so this binding adds no disposal rule. The scope is returned bare,
 * since nothing renders a read scope.
 */
export function useReadScope(subject: object, key: SubjectKey): ReadScope {
  return useSubjectScopedResource(subject, key, openReadScope, READ_SCOPE_DISPOSAL).value;
}
