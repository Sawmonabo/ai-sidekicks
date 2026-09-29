// The discovery surface: what the bound provider offers, and what this console can do.
//
// It is a command-and-skill autocomplete listing the target agent's own provider
// commands and skills with each entry's provider-supplied description — a DISCOVERY
// surface that shows what the bound provider offers rather than a launcher. Two
// consequences are structural here rather than conventional:
//
//   • SELECTING A PROVIDER ENTRY INSERTS NOTHING into the message box and starts no
//     turn, and the reason is not politeness: a provider entry is listed for discovery
//     only, and the send path answers a typed one by naming it rather than sending it,
//     so an insert-then-send affordance would compose text this shell's own send path
//     declines. That is about the PROVIDER half and says nothing about the console's
//     own commands, which the prefix is reserved FOR — and `/workflow start <name>` is
//     one of those, intercepted by the runtime and never forwarded anywhere. Typing its
//     directive onto the line is therefore the opposite case, and it is the one write
//     this seat makes to the line.
//   • THE ONE ACT ON A ROW IS THE CONSOLE'S OWN. A console command's row carries a
//     button — and that button runs the client-command executor, not a send. A
//     provider row carries no button at all, because there is nothing this console may
//     do with it.
//
// THE EMPTY STATE WAITS FOR EVERY APPLICABLE SOURCE. "No command matches what you
// have typed" is a claim about a SEARCH THAT FINISHED, and this popover reads two
// sources: the console's own command surface, which is local and always settled, and
// the provider enumeration, which has phases. So while that read is in flight or has
// been refused, the popover says so — through the one statement that read owns — and
// says nothing about matching, because the source that might hold the match has not
// answered. A list that DOES have entries keeps that statement beside it, unchanged:
// a partial list whose provider half is missing must still say the half is missing.
//
// AND A SEARCH THAT FINISHED OVER A TRUNCATED LIST IS NOT A SEARCH OVER THE PROVIDER.
// The reply's group carries `complete`, which is `false` when the provider published
// more entries than the registered per-group cap admits and the group's tail was
// dropped. Those entries are not here to match against, so the definitive empty claim
// is exactly as wrong as it is while the read is in flight — a person who typed the
// first letters of a dropped command would have been told no such command exists. The
// flag is carried into the rendered state, the empty claim is withheld under it, and
// the truncation is said whether the filter matched anything or not.
//
// ONE BINDING'S ENTRIES, AND NEVER A MERGE. The enumeration is agent-scoped and an
// agent can hold several live bindings at once, so the reply carries one group per
// binding. The popover renders the group the ADDRESSED RUN is on and no other:
// `provider-command-catalog.ts` owns the selection, and where no group can be
// attributed to this run's binding the provider half is an absence with its own
// sentence rather than another binding's list under this run's name.
//
// THE LIST ACTIVATES ITS ACTIVE ROW, AND ONLY ONE KIND OF ROW CAN BE ACTIVATED. A
// `role="listbox"` that moves an active descendant under the arrows and answers
// neither Enter nor Space is a control a keyboard-only person can point at and never
// use, so both keys settle the active row through the SAME executor the row's own
// button calls — one path, so a console act cannot behave differently by which
// gesture reached it. A provider row has no such path by design, and the key is
// therefore a no-op that SAYS SO: silence would be indistinguishable from a surface
// that had failed, and a disabled-looking control would assert the act exists here.
//
// THE SURFACE SPEAKS THROUGH ITS OWN STATUS REGION rather than through the window's
// live announcer. The announcer exists so a read a person did not trigger and is not
// looking at can still reach them; this popover is opened by their own keystroke and
// is where their attention already is, so speaking through the window-wide region as
// well would say everything twice.
//
// AND THIS SEAT IS WHERE THE WORKFLOW ACCELERATOR'S LINE-FACING HALF LIVES. The
// palette entry types the directive into the composer's LINE, which is this seat's
// own subject and not the send bar's.

import { useCallback, useMemo } from "react";
import { type ComposerProps } from "@renderer/console/seats/index.js";
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

export type CommandListProps = ComposerProps & {
  /** The composer region whose line this surface watches. It writes to none of it. */
  readonly region: React.RefObject<HTMLElement | null>;
  /**
   * The composer's one enumeration reading. THIS surface is what opens it: the
   * leading slash in the line is what makes the reading live, and the send path
   * observes the same holder rather than reading the wire a second time.
   */
  readonly commandEnumeration: ProviderCommandEnumeration;
};

export function CommandList(props: CommandListProps): React.JSX.Element | null {
  const { region, bridge, route, commandEnumeration, draftStore } = props;
  // The address is resolved here rather than handed down, exactly as the chip rail
  // and the send bar resolve it: one hook with three readers is one implementation,
  // and a host that passed the answer down would be a host that knew what each zone
  // was for.
  const { target } = useComposerAddress(props.sessionStore, props.focusedPane);
  const draftKey = composerDraftKey(target);
  // The same store and the same key the send bar reads its line from, so what this
  // surface sees and what the line displays are one reading rather than two that
  // agree only while somebody is typing.
  const discovery = useCommandListTrigger(region, { draftStore, draftKey });
  const isOpen = discovery.prefix !== undefined;
  const enumeration = useProviderCommandEnumeration({
    enumeration: commandEnumeration,
    bridge,
    target,
    isOpen,
  });
  // Contributes the palette entry that types the directive onto the line.
  useWorkflowStartPrefill({ draftStore, draftKey });

  const readSurface = useCallback(() => readComposerCommands(route), [route]);
  const addressed = useMemo(() => addressedProviderBinding(target), [target]);
  return isOpen ? (
    <CommandListPopover
      prefix={discovery.prefix ?? ""}
      readSurface={readSurface}
      enumeration={enumeration}
      addressed={addressed}
      stepIntoListToken={discovery.stepIntoListToken}
      onDismiss={discovery.dismiss}
    />
  ) : null;
}
