// The fixture shell for the timeline row FOOTER seat — reserved, not stubbed.
//
// THE SAME ABSORB-BY-IMPORT RULE `FixtureShellRows.tsx` is one half of, applied to the
// second seat: this registration is replaced by the affordance's owner, and this file
// is deleted in that same diff. The seat is owner-scoped, so a second owner is refused
// by name rather than winning by import order.
//
// WHY THERE IS NO STUB PENCIL BEHIND IT. A hover-revealed pencil that opened nothing —
// or worse, one that decided for itself whether this user may correct this row —
// would be the second source of eligibility truth the design forbids: the affordance is
// a fail-closed projection of a daemon predicate. So the shell renders the reserved
// answer and no control, which is the shape `shell/composer/accessories/EditResendSlot.tsx`
// already takes for the editor half of the same feature.
//
// IT IS ONE LINE AND IT IS INLINE, because it repeats once per user message
// rather than once per pane. A surface-placed absence under every message would be a
// paragraph of unbuilt-feature prose down the whole ledger.

import { Nothing } from "../../../primitives/index.js";
import {
  registerTimelineRowFooterRenderer,
  type TimelineRowFooterSlotProps,
} from "../../../seats/index.js";

/** The owner this shell claims the footer seat under. */
export const FIXTURE_SHELL_FOOTER_OWNER = "ledger fixture shell footer";

/**
 * Claim the footer seat for the shell.
 *
 * A function rather than a module-scope call, for `registerFixtureShellRows`' reason: a
 * module whose import registers a seat cannot be composed twice by a test, and the
 * seat's owner scoping would then refuse the second composition rather than replace it.
 */
export function registerFixtureShellRowFooter(): void {
  registerTimelineRowFooterRenderer(FIXTURE_SHELL_FOOTER_OWNER, FixtureShellRowFooter);
}

/**
 * The reserved footer.
 *
 * Reads nothing off the row on purpose: a shell that summarised the row would be
 * authoring a piece of the body it stands in for, and the owner would then have two.
 */
function FixtureShellRowFooter(_props: TimelineRowFooterSlotProps): React.JSX.Element {
  return (
    <Nothing
      kind="not-checked"
      placement="inline"
      title="Correcting a sent message has not been built yet."
    />
  );
}
