// The Runtime page: what the frame knows about the background service, one click behind the
// frame's chip.
//
// The frame shows the service's state as a chip; this page shows its detail, read from the
// supervisor and never editable. Starting a stopped service is a main-process spawn, not a
// call, so that control lives in the app frame (`layout/AppShell/hooks/useDaemonStartAction.ts`),
// beside the state that makes it right.
//
// The page draws the supervisor's facts from its context. The blocks that call the daemon
// (`DaemonOperationsBlocks.tsx`) arrive as `children`.

import type { ReactNode } from "react";

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { MainProcessState } from "@shared/daemon-status-topic.js";
import {
  UNREPORTED_DAEMON_NOTICE,
  describeDaemonConnection,
} from "@renderer/store/window/main-process-state.js";
import { SettingsFact } from "../../components/SettingsFact.js";
import type { SettingsPageContext } from "../../types.js";
import { MountedFoldersBlock } from "./mounted-folders/MountedFoldersBlock.js";

/** What the Runtime page is handed. */
export interface RuntimePageProps {
  readonly context: SettingsPageContext;
  /** What sits under the service's facts: the blocks that call the daemon. */
  readonly children?: ReactNode;
}

/** The page: the lede, what the supervisor reports about the service, and its folders. */
export function RuntimePage(props: RuntimePageProps): ReactNode {
  return (
    <section className="meridian-settings-page" aria-label="Runtime">
      <p className="meridian-settings-page__lede">
        The background service that runs your sidekicks, the folders it can reach, what it keeps,
        and the port it listens on.
      </p>

      <section className="meridian-settings-page__block">
        <dl className="meridian-settings-page__facts">
          {renderSupervisorFacts(props.context.mainProcessState)}
        </dl>
        <p className="meridian-settings-page__aside">
          Everything above is read from the service and is not edited here.
        </p>
      </section>

      {props.children}

      <MountedFoldersBlock />
    </section>
  );
}

/**
 * The supervisor's own numbers.
 *
 * The attempt count appears only on the two arms that have one, which is why the connection
 * is a union.
 */
function renderSupervisorFacts(state: MainProcessState): ReactNode {
  const { connection } = state;
  return (
    <>
      <SettingsFact term="State">
        {connection.kind === "unreported" ? (
          <Nothing kind="not-checked" placement="inline" title={UNREPORTED_DAEMON_NOTICE.title} />
        ) : (
          <span>{describeDaemonConnection(connection)}</span>
        )}
      </SettingsFact>
      {connection.kind === "transient_disconnect" ? (
        <SettingsFact term="Attempt">
          <span>
            {connection.attempt} of {connection.attemptLimit}
          </span>
        </SettingsFact>
      ) : null}
      {connection.kind === "degraded" ? (
        <SettingsFact term="Attempts spent">
          <span>
            {connection.attemptLimit} of {connection.attemptLimit}
          </span>
        </SettingsFact>
      ) : null}
      {connection.kind === "degraded" || connection.kind === "unknown" ? (
        <SettingsFact term="Last error">
          {connection.lastError === undefined ? (
            <Nothing kind="not-checked" placement="inline" title="No error recorded" />
          ) : (
            <WireFigure value={connection.lastError} />
          )}
        </SettingsFact>
      ) : null}
    </>
  );
}
