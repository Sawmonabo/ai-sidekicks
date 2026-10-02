// The command list: a discovery autocomplete of what the bound provider offers and what this
// console can do. A provider row inserts nothing and starts no turn; a console row's button
// and the Enter and Space keys run the same console-command executor. The empty claim is
// withheld while the provider read is in flight, refused, or truncated, and only the addressed
// run's binding group renders. It speaks through its own status region, not the announcer.

import { useCallback, useMemo } from "react";
import { type ComposerProps } from "@renderer/registries/composer/composer-registry.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { composerDraftKey } from "../../draft-line/draft-key.js";
import { readComposerCommands } from "../composer-commands.js";
import { useCommandListTrigger } from "../hooks/useCommandListTrigger.js";
import { addressedProviderBinding } from "../command-list-entries.js";
import { useProviderCommandEnumeration } from "../hooks/useProviderCommandEnumeration.js";
import { type ProviderCommandEnumeration } from "../provider-command-enumeration.js";
import { CommandListPopover } from "./CommandListPopover.js";
import { useWorkflowStartPrefill } from "../workflow-command/hooks/useWorkflowStartPrefill.js";

import "./CommandList.css";

/** Props for the command list. */
export type CommandListProps = ComposerProps & {
  /** The composer region whose line this list watches. It writes to none of it. */
  readonly region: React.RefObject<HTMLElement | null>;
  /**
   * The composer's one enumeration reading. This list opens it when the line starts with a
   * slash, and the send path observes the same holder rather than reading the wire again.
   */
  readonly commandEnumeration: ProviderCommandEnumeration;
};

/** Renders the discovery popover while the line starts with a slash, otherwise nothing. */
export function CommandList(props: CommandListProps): React.JSX.Element | null {
  const { region, bridge, route, commandEnumeration, draftStore } = props;
  // Resolved here, as the chip rail and the send bar do, rather than handed down.
  const { target } = useComposerAddress(props.sessionStore, props.focusedPane);
  const draftKey = composerDraftKey(target);
  // The same store and key the send bar reads its line from, so both see one reading.
  const discovery = useCommandListTrigger(region, { draftStore, draftKey });
  const isOpen = discovery.prefix !== undefined;
  const enumeration = useProviderCommandEnumeration({
    enumeration: commandEnumeration,
    bridge,
    target,
    isOpen,
  });
  // Contributes the palette entry that types the command word onto the line.
  useWorkflowStartPrefill({ draftStore, draftKey });

  const readCommands = useCallback(() => readComposerCommands(route), [route]);
  const addressed = useMemo(() => addressedProviderBinding(target), [target]);
  return isOpen ? (
    <CommandListPopover
      prefix={discovery.prefix ?? ""}
      readCommands={readCommands}
      enumeration={enumeration}
      addressed={addressed}
      stepIntoListToken={discovery.stepIntoListToken}
      onDismiss={discovery.dismiss}
    />
  ) : null;
}
