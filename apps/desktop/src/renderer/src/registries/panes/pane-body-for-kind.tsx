// Adapts a body written for one pane kind into the render the pane registry stores.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { TITLE_BY_PANE_KIND } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { type PaneContext } from "./pane-context.js";

/** The subsystem a pane-composition refusal names as its author. */
const PANE_COMPOSITION_ORIGIN = "pane-composition";

/** The context a body of one pane kind is handed, narrowed to that kind's arm. */
export type PaneContextOf<TKind extends PaneKind> = Extract<PaneContext, { kind: TKind }>;

/**
 * The member a body with the wrong context type fails to satisfy. A unique symbol so the compiler
 * error names the rule instead of an anonymous object.
 */
declare const PANE_BODY_TAKES_ITS_OWN_KINDS_CONTEXT: unique symbol;

/**
 * Adapts a body written for one pane kind into the render the registry stores, narrowing the whole
 * `PaneContext` union once here. A mismatch renders a refusal and never throws: the layout looks
 * bodies up by kind, but a restored layout row or a typed route can arrive untyped, and a throw
 * would take the whole window down for one pane.
 */
export function paneBodyForKind<
  TKind extends PaneKind,
  TBody extends (context: PaneContextOf<TKind>) => React.ReactNode,
>(
  kind: TKind,
  renderBody: TBody & ExactPaneBody<TKind, TBody>,
): (context: PaneContext) => React.ReactNode {
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
 * Nothing for a body whose parameter is exactly this kind's context; a refusal otherwise.
 * Exactness, not assignability: parameters are contravariant, so a body typed with a subset such as
 * a `Pick` or a hand-written props interface would compile and restate the contract per feature.
 * A body with no parameter is admitted. The tuple wrappers stop the checks distributing over the
 * context union.
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
