// Who holds the shell, in words, for the holders the lease line draws: another of the person's
// devices, by its name, or an agent's running command, by the agent's name. While the confirm is
// open the device sentence asks the question, and the confirm is named by it.
//
// The holder is said through the announcer when it appears or changes after the pane's first read,
// a hold that comes back after this device held the shell included, since the sentence mounts
// again; the question is the person's own act, read as the confirm's name when focus lands in it.

import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import type { DrawnLeaseHolder } from "../state.js";

/** The holder the sentence words, the name it is worded with, and whether the confirm is open. */
export interface LeaseHolderSentenceProps {
  /** The element id the confirm names itself by. */
  readonly id: string;
  readonly holder: DrawnLeaseHolder;
  /** The holding device's name, or the holding run's agent's name. */
  readonly holderName: string;
  readonly isConfirming: boolean;
}

/** One sentence saying who holds the shell, or asking whether to take it. */
export function LeaseHolderSentence(props: LeaseHolderSentenceProps): React.JSX.Element {
  const { id, holder, holderName, isConfirming } = props;
  const rest =
    holder === "held-by-run" ? "'s running command holds the shell." : " holds the shell.";
  useAnnounceWhenChanged(`${holderName}${rest}`, "polite");
  return (
    <span id={id} className="meridian-terminal-lease-line__sentence">
      <strong className="meridian-terminal-lease-line__holder-name">{holderName}</strong>
      {rest}
      {isConfirming ? " Take it?" : ""}
    </span>
  );
}
