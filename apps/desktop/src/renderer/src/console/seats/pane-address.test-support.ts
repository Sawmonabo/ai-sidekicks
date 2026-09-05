// The entity references and the refusal reader both pane-address suites drive.
//
// The rows this family declares are read at two doors — the compiler's and the untyped
// boundary's — and each door has its own file. These four references and this reader are
// what both of them build a case out of, so they are here rather than written twice: two
// copies of `refusalFrom` is two answers to "the parse admitted something it should have
// refused", and the one that is not looked at is the one that stops saying which.

import { isConsoleRefusal } from "../core/index.js";
import type { ConsoleEntityRef } from "../store/index.js";
import { parseConsolePaneAddress } from "./pane-address-parse.js";

/**
 * A `ConsoleEntityRef` whose kind is pinned to one literal.
 *
 * An annotation rather than `as const satisfies`, because `isolatedDeclarations` needs
 * an explicit type on an exported binding — and an intersection rather than `Extract`,
 * because `ConsoleEntityRef` is one interface over the kind vocabulary rather than a
 * union of per-kind members, so extracting from it yields `never`. Pinned rather than
 * left at the bare union because a case hands these to an address arm that admits one
 * kind and nothing else.
 */
type EntityRefOf<TKind extends ConsoleEntityRef["kind"]> = ConsoleEntityRef & {
  readonly kind: TKind;
};

export const AGENT: EntityRefOf<"agent"> = { kind: "agent", id: "agent-1" };
export const RUN: EntityRefOf<"run"> = { kind: "run", id: "run-1" };
export const ARTIFACT: EntityRefOf<"artifact"> = { kind: "artifact", id: "artifact-1" };
/** Still a registered entity kind, and no longer one any pane kind is a view of. */
export const BROWSER_PAGE: EntityRefOf<"browser-page"> = { kind: "browser-page", id: "page-1" };

/** The refusal a parse answered with, or a failure naming what it admitted instead. */
export function refusalFrom(outcome: ReturnType<typeof parseConsolePaneAddress>): {
  readonly code: string;
  readonly detail: string;
  readonly origin: string;
} {
  if (!isConsoleRefusal(outcome)) {
    throw new Error(`the parse admitted a "${outcome.kind}" address it should have refused`);
  }
  return outcome;
}
