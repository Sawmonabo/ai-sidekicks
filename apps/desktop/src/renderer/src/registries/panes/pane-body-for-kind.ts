// Adapts a body written for one pane kind into the render the pane registry stores.

import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { type PaneContext } from "./pane-context.js";

/** The context a body of one pane kind is handed, narrowed to that kind's arm. */
export type PaneContextOf<TKind extends PaneKind> = Extract<PaneContext, { kind: TKind }>;

/**
 * The member a body with the wrong context type fails to satisfy. A unique symbol so the compiler
 * error names the rule instead of an anonymous object.
 */
declare const PANE_BODY_TAKES_ITS_OWN_KINDS_CONTEXT: unique symbol;

/**
 * Adapts a body written for one pane kind into the render the registry stores, narrowing the whole
 * `PaneContext` union once here. The registry looks a body up by the context's own kind, so a
 * mismatch means a feature registered this body under another kind, and it throws as that defect.
 */
export function paneBodyForKind<
  TKind extends PaneKind,
  TBody extends (context: PaneContextOf<TKind>) => React.ReactNode,
>(
  kind: TKind,
  renderBody: TBody & ExactPaneBody<TKind, TBody>,
): (context: PaneContext) => React.ReactNode {
  return (context) => {
    if (context.kind !== kind) {
      throw new Error(`The "${kind}" pane body was registered under the "${context.kind}" kind.`);
    }
    return renderBody(context as PaneContextOf<TKind>);
  };
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
