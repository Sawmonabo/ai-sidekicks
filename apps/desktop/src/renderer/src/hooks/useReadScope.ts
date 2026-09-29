import {
  useSubjectScopedResource,
  type SubjectScopedTerminalDisposal,
} from "./subject-scoped/useSubjectScopedResource.js";
import { ReadScope } from "@renderer/lib/reads/read-scope.js";
import { type SubjectKey } from "@renderer/lib/subject-scoped/subject-scoped-holder.js";

/**
 * Mint one scope per read line. A module-level function, so the hook below hands the
 * holder a stable identity and the steady render allocates nothing.
 */
function openReadScope(): ReadScope {
  return new ReadScope();
}

/**
 * The disposal a scope has, stated once.
 *
 * TERMINAL AND NOT RELEASING, and the reading beside it is what makes React's
 * double-mount survivable: the committed cleanup abandons the scope, the effect then
 * re-runs against that same abandoned scope, and without `isClosed` the surface would
 * spend the rest of its life reading through a line that can never open a live round
 * again — invisible until something is read.
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
 * `useSubjectScopedResource` OWNS EVERY HARD PART OF THIS, which is why the binding is
 * four lines and not a lifetime of its own. A scope opened by a render React throws
 * away is closed by the holder inside that render; one the subject moved out from
 * under is closed by the effect that held it; one the double-mount disposed is
 * recognised and re-minted. Writing any of that again here would be a second
 * disposal rule for a family that has one.
 *
 * The scope is returned bare rather than as its holder's state, because nothing
 * renders a read scope: it is handed to a read and read by nobody.
 */
export function useReadScope(subject: object, key: SubjectKey): ReadScope {
  return useSubjectScopedResource(subject, key, openReadScope, READ_SCOPE_DISPOSAL).value;
}
