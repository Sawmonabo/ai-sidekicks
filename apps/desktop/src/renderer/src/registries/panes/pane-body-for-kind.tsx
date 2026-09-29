// Adapts a body written for one pane kind into the render the pane registry stores.

import { InlineRefusal } from "@renderer/console/primitives/index.js";
import { TITLE_BY_PANE_KIND } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { type ConsolePaneContext } from "./pane-context.js";

/** The subsystem a pane-composition refusal names as its author. */
const PANE_COMPOSITION_ORIGIN = "pane-composition";

/** The context a body of one pane kind is handed, narrowed to that kind's arm. */
export type PaneContextOf<TKind extends PaneKind> = Extract<ConsolePaneContext, { kind: TKind }>;

/**
 * What a body that does not take its own kind's context resolves to.
 *
 * A UNIQUE SYMBOL SO THE FAILURE NAMES THE RULE. The mechanism is an intersection the
 * argument cannot satisfy, and without a distinctive member the compiler reports it as
 * an unassignable anonymous object — a reader would see a type error and not the
 * standard it broke.
 */
declare const PANE_BODY_TAKES_ITS_OWN_KINDS_CONTEXT: unique symbol;

/**
 * Adapt a body written for ONE pane kind into the render the registry stores.
 *
 * `ConsolePaneDescriptor.render` takes the whole `ConsolePaneContext` union, because
 * one registry holds every kind. A body does not: an inspector reads an entity the
 * runs pane's arm does not carry, which is the property the kind-scoped address union
 * exists to hold. So the narrowing happens once, here, rather than six times in six
 * families with six different answers for the arm that cannot be served.
 *
 * A MISMATCH IS A RENDERED REFUSAL AND NEVER A THROW. The deck looks a body up BY kind
 * and hands it a context addressed at that kind, so the arm below is unreachable
 * through the deck — but the two untyped boundaries (a restored layout row, a typed
 * route) are where an address arrives without the compiler, and `core/refusal.ts`'s
 * rule is that one bad row loses that row rather than the deck. A throw here would take
 * the whole window down for a pane; the refusal keeps the frame and names what was
 * asked for.
 */
export function paneBodyForKind<
  TKind extends PaneKind,
  TBody extends (context: PaneContextOf<TKind>) => React.ReactNode,
>(
  kind: TKind,
  renderBody: TBody & ExactPaneBody<TKind, TBody>,
): (context: ConsolePaneContext) => React.ReactNode {
  return (context) =>
    context.kind === kind ? (
      renderBody(context as PaneContextOf<TKind>)
    ) : (
      <InlineRefusal
        code={`${PANE_COMPOSITION_ORIGIN}.pane-kind-mismatch`}
        detail={`the ${TITLE_BY_PANE_KIND[kind]} pane was mounted at a "${context.kind}" address, which it is not a view of`}
      />
    );
}

/**
 * Nothing, for a body whose parameter is EXACTLY this kind's context; a refusal
 * otherwise.
 *
 * WHY EXACTNESS AND NOT ASSIGNABILITY. A function parameter is checked
 * contravariantly, so a body annotated with a WIDER type than the context — a
 * `Pick<…>` of two members, a hand-written props interface naming a subset — is
 * assignable and compiled silently. That is how one pane body came to declare its own
 * props type while its sibling used the seat's: both compiled, and the seat's contract
 * was restated per family with nothing reporting the divergence. Mutual assignability
 * is what separates "safe" from "the same type".
 *
 * A BODY THAT DECLARES NO PARAMETER IS ADMITTED. Ignoring the context is not restating
 * it — there is no second spelling of the contract to drift from — and most pane
 * bodies in the tree take nothing at all.
 *
 * The tuple wrappers stop both checks distributing over the context union, which would
 * ask the question arm by arm and answer it for a kind nobody named.
 */
type ExactPaneBody<
  TKind extends PaneKind,
  TBody extends (context: PaneContextOf<TKind>) => React.ReactNode,
> = Parameters<TBody>["length"] extends 0
  ? unknown
  : [Parameters<TBody>[0]] extends [PaneContextOf<TKind>]
    ? [PaneContextOf<TKind>] extends [Parameters<TBody>[0]]
      ? unknown
      : { readonly [PANE_BODY_TAKES_ITS_OWN_KINDS_CONTEXT]: TKind }
    : { readonly [PANE_BODY_TAKES_ITS_OWN_KINDS_CONTEXT]: TKind };
