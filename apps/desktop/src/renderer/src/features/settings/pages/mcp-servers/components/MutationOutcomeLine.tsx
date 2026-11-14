import type { ReactNode } from "react";

import { MCP_SERVER_SIGN_IN_FAILED_CODE } from "@ai-sidekicks/contracts/mcp/governance";
import type { SessionListEntry } from "@ai-sidekicks/contracts/session/directory";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import type { Clock } from "#renderer/lib/clock.js";
import {
  listedSessionOf,
  type SessionDirectoryState,
} from "#renderer/store/session/directory/state.js";
import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import { providerNameOf } from "#renderer/store/providers/name.js";
import { settleLineFor } from "../change-settle-words.js";
import { mcpLiveLegKeyOf } from "../live-leg-key.js";
import { SIGN_IN_UNFINISHED_WORDS, type McpMutationOutcome } from "../mutation.js";
import { SessionName, sessionNameWords } from "./SessionName.js";

/**
 * What the last change to one control did, in place: `Sending…` while it is on its way, once past
 * the short delay; then one line for each grade the service answered, saying when the change
 * takes effect, and one line for each running session it failed on, named as the session list
 * names it; or, for a sign-in, that its page opened in the browser. Handed `onTryAgain`, a
 * refusal draws as the strip ending in `Try again`. A session the list does not name yet gets its
 * line only once its name arrives, so no placeholder is ever read out as a name.
 *
 * A partial outcome reads as one: a change can be saved and still miss one running session, and
 * a single verdict would leave that session on the old setting while the person believes it
 * moved. No grade, outcome value, error code or session id reaches the screen.
 */
export function MutationOutcomeLine(props: {
  readonly outcome: McpMutationOutcome;
  /** The service's sessions, which name a session the change failed on. */
  readonly sessionDirectory: SessionDirectoryState;
  /** The window's clock, which holds `Sending…` back for the short delay. */
  readonly clock: Clock;
  /** Sends the refused change again, drawing a refusal as the strip ending in `Try again`. */
  readonly onTryAgain?: () => void;
}): ReactNode {
  const { outcome, sessionDirectory, clock, onTryAgain } = props;
  const providerSections = useProviderSections();
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "sending") {
    return <LoadingNotice clock={clock} placement="inline" title="Sending…" />;
  }
  if (outcome.kind === "refused") {
    const { code, detail } = outcome.refusal;
    return (
      <InlineRefusal
        code={code}
        detail={code === MCP_SERVER_SIGN_IN_FAILED_CODE ? SIGN_IN_UNFINISHED_WORDS : detail}
        onTryAgain={onTryAgain}
      />
    );
  }
  if (outcome.kind === "signInPageOpened") {
    return (
      <div className="meridian-mcp__outcome">
        <AnnouncedLine
          element="p"
          className="meridian-settings-page__state"
          words={SIGN_IN_PAGE_OPENED_WORDS}
          politeness="polite"
        />
      </div>
    );
  }
  const { binding, settlement } = outcome;
  const failedResults = (settlement.liveResults ?? []).filter(
    (liveResult) => liveResult.outcome === "failed",
  );
  // Each line is said on its own, so a session the list names later adds only its own line.
  return (
    <div className="meridian-mcp__outcome">
      {settlement.grades.map((grade) => (
        <AnnouncedLine
          key={grade}
          element="p"
          className="meridian-settings-page__state"
          words={settleLineFor(grade, providerNameOf(providerSections, binding.provider))}
          politeness="polite"
        />
      ))}
      {failedResults.map((liveResult) => (
        <FailedSessionLine
          key={mcpLiveLegKeyOf(liveResult)}
          entry={listedSessionOf(sessionDirectory, liveResult.sessionId)}
        />
      ))}
    </div>
  );
}

/**
 * One running session the change failed on, drawn only while the list names it. It stays mounted
 * while the list is lost, so a list restated in the same words is a re-read and says nothing; a
 * new settlement follows `Sending…`, which replaces the lines, so it mounts this one anew.
 */
function FailedSessionLine(props: { readonly entry: SessionListEntry | undefined }): ReactNode {
  const { entry } = props;
  useAnnounceWhenChanged(
    entry === undefined ? undefined : `${sessionNameWords(entry)} ${OLD_SETTING_WORDS}`,
    "polite",
  );
  return entry === undefined ? null : (
    <p className="meridian-settings-page__state">
      <SessionName entry={entry} /> {OLD_SETTING_WORDS}
    </p>
  );
}

/** What a sign-in whose page reached the browser settles with. */
const SIGN_IN_PAGE_OPENED_WORDS = "The sign-in for that server opened in the default browser.";

/** What a running session the change could not reach reads after its name. */
const OLD_SETTING_WORDS = "is still running with the old setting.";
