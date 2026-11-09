// The banners a session's standing notices raise, under its header: a crash loop's with `Restart`,
// which asks the daemon to start the provider again, an ignored-settings banner with `Open the
// file` where main gave a token for its file, and a lost folder's, which goes when the folder is
// back. A × puts a crash loop's or a settings banner away for the notice that raised it, for as
// long as the session stays open.

import { useMemo, useReducer } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import { providerNameOf } from "#renderer/store/providers/name.js";
import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { DismissedSessionNotices } from "#renderer/store/session/open/dismissed-notices.js";

import { useLostFolderPaths } from "../hooks/useLostFolderPaths.js";
import {
  foldSessionNoticeBanners,
  sessionNoticeBannerWords,
  type SessionNoticeBanner,
} from "../notices.js";
import { SessionBannerRow, type SessionBannerAct } from "./SessionBannerRow.js";

/** What the notice banners read, act through and report a refused folder read to. */
export interface SessionNoticeBannersProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: string;
  readonly sessionStore: SessionStore;
  readonly dismissed: DismissedSessionNotices;
  readonly onFolderReadRefused: (repoMountId: string, refusal: ExtendedRefusal) => void;
}

/** The session's notice banners, in the order their notices arrived; nothing while none stands. */
export function SessionNoticeBanners(props: SessionNoticeBannersProps): React.JSX.Element | null {
  const standingEvents = useSessionStore(props.sessionStore, selectStandingEvents);
  // A dismissal moves no store, so the screen draws again on its own word.
  const [, drawAgain] = useReducer((count: number) => count + 1, 0);
  const { dismissed } = props;
  const dismissedEventIds = dismissed.eventIds;
  const banners = useMemo(
    () =>
      foldSessionNoticeBanners(standingEvents).filter(
        (banner) => !dismissedEventIds.has(banner.eventId),
      ),
    [standingEvents, dismissedEventIds],
  );
  if (banners.length === 0) {
    return null;
  }
  return (
    <NoticeBannerRows
      {...props}
      banners={banners}
      onDismiss={(eventId) => {
        dismissed.dismiss(eventId);
        drawAgain();
      }}
    />
  );
}

// The origin a refused `Open the file` names.
const OPEN_THE_FILE_ORIGIN = "session-banner";

// The rows, apart from the fold, so the providers' names are read only while a banner stands.
function NoticeBannerRows(
  props: SessionNoticeBannersProps & {
    readonly banners: readonly SessionNoticeBanner[];
    readonly onDismiss: (eventId: string) => void;
  },
): React.JSX.Element {
  const sections = useProviderSections();
  const { bridge, sessionId, onDismiss } = props;
  const lostMountIds = props.banners.flatMap((banner) =>
    banner.kind === "folderLost" ? [banner.repoMountId] : [],
  );
  const folderPaths = useLostFolderPaths(bridge, lostMountIds, props.onFolderReadRefused);

  return (
    <>
      {props.banners.map((banner) => {
        const words = sessionNoticeBannerWords(
          banner,
          banner.kind === "folderLost" ? "" : providerNameOf(sections, banner.provider),
          banner.kind === "folderLost" ? folderPaths.get(banner.repoMountId) : undefined,
        );
        if (words.length === 0) {
          return null;
        }
        const act = bannerActOf(banner, bridge, sessionId);
        return (
          <SessionBannerRow
            key={banner.eventId}
            words={words}
            {...(act === undefined ? {} : { act })}
            // A lost folder's banner goes on its own, when the folder is back.
            {...(banner.kind === "folderLost"
              ? {}
              : {
                  onDismiss: () => {
                    onDismiss(banner.eventId);
                  },
                })}
          />
        );
      })}
    </>
  );
}

function bannerActOf(
  banner: SessionNoticeBanner,
  bridge: PlatformBridge,
  sessionId: string,
): SessionBannerAct | undefined {
  switch (banner.kind) {
    case "crashLoop":
      return {
        label: "Restart",
        press: async () => {
          const reply = await callDaemon(bridge, "session.restart", {
            sessionId: heldIdAsWireId<SessionId>(sessionId),
          });
          return reply.status === "refused" ? reply.refusal : undefined;
        },
      };
    case "settingsIgnored": {
      const { fileRef, line } = banner;
      return fileRef === undefined
        ? undefined
        : {
            label: "Open the file",
            press: () =>
              bridge.native.openInEditor(fileRef, line).then(
                () => undefined,
                (error: unknown) => coerceToRefusal(error, OPEN_THE_FILE_ORIGIN, "file-not-opened"),
              ),
          };
    }
    case "folderLost":
      return undefined;
  }
}
