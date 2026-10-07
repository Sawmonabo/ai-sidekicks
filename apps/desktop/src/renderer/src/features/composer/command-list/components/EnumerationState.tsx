// What the command popover says about its own enumeration. The state (reading, refused, cut short)
// is a fact about the read, not the commands, so it is its own line rather than a selectable entry
// with nothing to send.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider/driver/commands";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { PartialRead } from "#renderer/components/PartialRead/PartialRead.js";
import { type ReadingState } from "#renderer/lib/partial-read.js";
import { useProviderCommandEnumeration } from "../hooks/useProviderCommandEnumeration.js";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";

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
      // No live role: the state announces itself through the app's announcer.
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
      // No live role: the loading line and the refusal below announce themselves through the
      // app's announcer.
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
        return (
          <AnnouncedLine
            element="div"
            className="meridian-command-discovery__state"
            words={`${NOTHING_PUBLISHED_TITLE}. ${NOTHING_PUBLISHED_DETAIL}`}
            politeness="polite"
          >
            <Nothing
              kind="empty"
              title={NOTHING_PUBLISHED_TITLE}
              detail={NOTHING_PUBLISHED_DETAIL}
            />
          </AnnouncedLine>
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

/** What the list says where the reply holds no group for this run's binding. */
const NOTHING_PUBLISHED_TITLE = "This run's binding published nothing here";

/** Why no provider entry is offered then. */
const NOTHING_PUBLISHED_DETAIL =
  "The sidekick answered for the bindings it holds and none of them could be attributed to " +
  "the run this composer is addressed to, so no provider entry is offered — another " +
  "binding's commands are never shown under this one.";
