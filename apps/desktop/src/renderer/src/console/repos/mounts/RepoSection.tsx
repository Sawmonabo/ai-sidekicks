import { useCallback, useState } from "react";

import { type ConsoleRefusal } from "../../core/index.js";
import { RefusalCard } from "../../primitives/index.js";

import { type SidebarSectionContext } from "../../seats/index.js";

import { useRepoMounts } from "./repo-mounts-reader.js";
import { repoCallRefusal } from "../repo-reads.js";
import { EphemeralCloneList } from "./EphemeralCloneList.js";
import { MountList } from "./MountList.js";
import { RepoMountsSummary } from "./RepoMountsSummary.js";

export interface RepoSectionProps {
  readonly context: SidebarSectionContext;
}

export function RepoSection(props: RepoSectionProps): React.JSX.Element {
  const { bridge, sessionStore, isOpen } = props.context;
  const { reading, requestModeSelection } = useRepoMounts(bridge, sessionStore);
  const [copyRefusal, setCopyRefusal] = useState<ConsoleRefusal | undefined>(undefined);

  const copyCanonicalRoot = useCallback(
    (canonicalRoot: string) => {
      setCopyRefusal(undefined);
      bridge.sidekicks.native.copyToClipboard(canonicalRoot).catch((rejection: unknown) => {
        // The host refused the clipboard. Rendered rather than swallowed: the root is
        // still on screen and still recoverable through the element's title, so the
        // person needs to know the copy did not happen, not be told it did.
        setCopyRefusal(repoCallRefusal("native.copyToClipboard", rejection));
      });
    },
    [bridge],
  );

  if (!isOpen) {
    return (
      <p className="meridian-repo-section__summary">
        <RepoMountsSummary reading={reading} />
      </p>
    );
  }

  return (
    <div className="meridian-repo-section">
      <div className="meridian-repo-section__mounts">
        {reading.refusal !== undefined ? (
          <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />
        ) : null}
        {copyRefusal !== undefined ? (
          <RefusalCard code={copyRefusal.code} detail={copyRefusal.detail} />
        ) : null}
        <MountList
          reading={reading}
          bridge={bridge}
          sessionStore={sessionStore}
          onCopy={copyCanonicalRoot}
          onSelect={requestModeSelection}
        />
        {/*
          DRAWN WHATEVER THE MOUNT READ DID. The clone list comes off
          `repo.worktreeStatusRead`, which is a different call with a different scope:
          one `repo.mountRead` failing sets the section's refusal and says nothing at
          all about the roots this session holds. Gating the list on that refusal took
          valid execution roots off the screen because an unrelated mount could not be
          probed. What the list is allowed to say is decided by its OWN reading below.
        */}
        <EphemeralCloneList reading={reading} bridge={bridge} sessionStore={sessionStore} />
      </div>
    </div>
  );
}
