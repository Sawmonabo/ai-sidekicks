// What the command popover says about its own enumeration. The state (reading, refused, no group)
// is a fact about the read, not the commands, so it is its own line rather than a selectable entry
// with nothing to send.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider/driver/commands";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useProviderCommandEnumeration } from "../hooks/useProviderCommandEnumeration.js";

/**
 * The provider half of the list when it is not the whole list: nobody asked, reading, refused, or
 * no group attributable to this run's binding (a routing absence, not a claim about the catalog).
 * Takes the group, not a flag, so it cannot disagree with the list.
 */
export function EnumerationState(props: {
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
  /** The served reading's group for this composer's run, where one was attributed. */
  readonly addressedGroup: ProviderCommandBindingGroup | undefined;
}): React.JSX.Element | null {
  const { enumeration, addressedGroup } = props;
  switch (enumeration.phase) {
    case "not-checked":
      // Drawn as the list opens, so it is read by browsing rather than said.
      return (
        <div className="meridian-command-discovery__state">
          <Nothing
            kind="not-checked"
            title="No sidekick is addressed, so no provider was asked"
            detail={
              "Focus a sidekick's pane to see the commands and skills its " +
              "bound provider publishes."
            }
          />
        </div>
      );
    case "not-loaded":
      return (
        <div className="meridian-command-discovery__state">
          <Nothing kind="not-loaded" title="Reading the provider's commands and skills" />
        </div>
      );
    case "refused":
      return (
        <div className="meridian-command-discovery__state">
          <InlineRefusal code={enumeration.refusal.code} detail={enumeration.refusal.detail} />
        </div>
      );
    case "served":
      if (addressedGroup === undefined) {
        // The read's own answer, read by browsing rather than said.
        return (
          <div className="meridian-command-discovery__state">
            <Nothing
              kind="empty"
              title="This run's binding published nothing here"
              detail={
                "The sidekick answered for the bindings it holds and none of " +
                "them could be attributed to the run this composer is addressed " +
                "to, so no provider entry is offered — another binding's " +
                "commands are never shown under this one."
              }
            />
          </div>
        );
      }
      return null;
  }
}
