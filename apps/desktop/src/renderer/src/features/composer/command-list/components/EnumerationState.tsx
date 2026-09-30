// What the command popover says about its own enumeration. The state (reading, refused, cut short)
// is a fact about the read, not the commands, so it is its own line rather than a selectable entry
// with nothing to send.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { PartialRead } from "@renderer/components/PartialRead/PartialRead.js";
import { type ReadingState } from "@renderer/lib/partial-read.js";
import { useProviderCommandEnumeration } from "../hooks/useProviderCommandEnumeration.js";

/**
 * The provider half of the list when it is not the whole list: nobody asked, reading, refused, no
 * group attributable to this run's binding (a routing absence, not a claim about the catalog), or a
 * group the reply says was cut. Takes the group, not a flag, so it cannot disagree with the list.
 */
export function EnumerationState(props: {
  readonly enumeration: ReturnType<typeof useProviderCommandEnumeration>;
  /** The served reading's group for this composer's run, where one was attributed. */
  readonly addressedGroup: ProviderCommandBindingGroup | undefined;
}): React.JSX.Element | null {
  const { enumeration, addressedGroup } = props;
  switch (enumeration.phase) {
    case "not-checked":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <Nothing
            kind="not-checked"
            title="No agent is addressed, so no provider was asked"
            detail="Focus an agent's pane to see the commands and skills its bound provider publishes."
          />
        </div>
      );
    case "not-loaded":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <Nothing kind="not-loaded" title="Reading the provider's commands and skills" />
        </div>
      );
    case "refused":
      return (
        <div className="meridian-command-discovery__state" role="status">
          <InlineRefusal code={enumeration.refusal.code} detail={enumeration.refusal.detail} />
        </div>
      );
    case "served":
      if (addressedGroup === undefined) {
        return (
          <div className="meridian-command-discovery__state" role="status">
            <Nothing
              kind="empty"
              title="This run's binding published nothing here"
              detail="The agent answered for the bindings it holds and none of them could be attributed to the run this composer is addressed to, so no provider entry is offered — another binding's commands are never shown under this one."
            />
          </div>
        );
      }
      // Said whether or not the filter matched: a nonempty list off a cut enumeration looks
      // exhaustive. The figure is what the group carried; how many were dropped is not on the wire.
      return (
        <PartialRead
          states={[cutEnumerationReading(addressedGroup)]}
          subject="this run's command list"
        />
      );
  }
}

/**
 * A served group's own account of how complete its list is. `cut` says a producer stopped short
 * without a figure for what it dropped; a complete group is `served`, which renders nothing.
 */
function cutEnumerationReading(group: ProviderCommandBindingGroup): ReadingState {
  return group.complete ? { kind: "served" } : { kind: "cut", servedCount: group.entries.length };
}
