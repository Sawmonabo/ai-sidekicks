// The command list: a discovery autocomplete of what the bound provider offers, what this console
// can do and the skills the addressed provider runs. A provider row inserts nothing and starts no
// turn; a press on a console row and the Enter and Space keys run the same console-command
// executor; a skill row puts the skill's call form at the head of the line and adds the pick to
// what rides with the draft. The list is drawn only while a row matches what is typed, and only
// the addressed run's binding group renders. The skills are read only while the list is open.
// What it says out loud goes through the app's announcer.

import { useCallback, useMemo, useRef } from "react";
import { type ComposerProps } from "#renderer/registries/composer/registry.js";
import { skillListFeedFor } from "#renderer/services/daemon/skills.js";
import { useSkillListState } from "#renderer/store/skills/hooks/useSkillListState.js";
import type { ComposerHeldDraft } from "../../held-draft/holder.js";
import { splitFirstWord } from "../../slash-command-syntax.js";
import { useComposerAddress } from "../../hooks/useComposerAddress.js";
import { composerDraftKey } from "../../draft-line/draft-key.js";
import { readComposerCommands } from "../registry-view.js";
import { useCommandListTrigger } from "../hooks/useCommandListTrigger.js";
import { addressedProviderBinding, type SkillCommandEntry } from "../entries.js";
import { useProviderCommandEnumeration } from "../hooks/useProviderCommandEnumeration.js";
import { type ProviderCommandEnumeration } from "../provider/enumeration.js";
import { CommandListPopover } from "./CommandListPopover.js";

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
  /** What rides with the draft, which a picked skill joins. */
  readonly heldDraft: ComposerHeldDraft;
};

/** Renders the discovery popover while the line starts with a slash, otherwise nothing. */
export function CommandList(props: CommandListProps): React.JSX.Element | null {
  const { region, bridge, route, commandEnumeration, draftStore, heldDraft } = props;
  // Resolved here, as the toolbar and Send do, rather than handed down.
  const target = useComposerAddress(props.sessionStore);
  const draftKey = composerDraftKey(props.sessionStore.sessionId);
  // The same store and key the send bar reads its line from, so both see one reading.
  // The open popover answers the line's Enter through this, so Enter chooses its active row.
  const lineEnterChoiceRef = useRef<(() => boolean) | undefined>(undefined);
  const discovery = useCommandListTrigger(region, { draftStore, draftKey }, lineEnterChoiceRef);
  const isOpen = discovery.prefix !== undefined;
  const enumeration = useProviderCommandEnumeration({
    enumeration: commandEnumeration,
    bridge,
    target,
    isOpen,
  });
  const readCommands = useCallback(() => readComposerCommands(route), [route]);
  const addressed = useMemo(() => addressedProviderBinding(target), [target]);
  const skills = useSkillListState(isOpen ? skillListFeedFor(bridge) : undefined);
  const { dismiss } = discovery;
  // The call form replaces the typed word and the rest of the line stays; the pick rides with the
  // draft, so the send names the folder picked.
  const pickSkill = useCallback(
    (entry: SkillCommandEntry) => {
      const { rest } = splitFirstWord(draftStore.read(draftKey)?.text ?? "");
      draftStore.write(draftKey, `${entry.callForm}${rest.length === 0 ? " " : rest}`);
      heldDraft.addSkillPick(entry.pick, entry.callForm);
      dismiss();
    },
    [draftStore, draftKey, heldDraft, dismiss],
  );
  return isOpen ? (
    <CommandListPopover
      prefix={discovery.prefix ?? ""}
      readCommands={readCommands}
      enumeration={enumeration}
      skills={skills.state}
      onReadSkillsAgain={skills.readAgain}
      onPickSkill={pickSkill}
      addressed={addressed}
      stepIntoListToken={discovery.stepIntoListToken}
      lineEnterChoiceRef={lineEnterChoiceRef}
      onDismiss={discovery.dismiss}
    />
  ) : null;
}
