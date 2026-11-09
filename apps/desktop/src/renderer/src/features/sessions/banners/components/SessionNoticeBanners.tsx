// The banners a session's standing notices raise, under its header: a crash loop's with `Restart`,
// which asks the daemon to start the provider again, an ignored-settings banner with `Open the
// file` where main gave a token for its file, and a lost folder's, which goes when the folder is
// back. A folder holding another repository offers `Re-attach` while git still answers for it and
// `Open folder…` once it holds none. A × puts a crash loop's or a settings banner away for the
// notice that raised it, for as long as the session stays open.

import { useMemo, useReducer } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PickedFolder } from "#shared/preload-api.js";
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
  refusedLine,
  sessionNoticeBannerWords,
  type SessionNoticeBanner,
} from "../notices.js";
import { reattachFolder } from "../reattach.js";
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

// The origin a press that failed on this side of the wire names: `Open the file`, or the picker
// under `Open folder…`.
const BANNER_ORIGIN = "session-banner";

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
        const act = bannerActOf(
          banner,
          bridge,
          sessionId,
          banner.kind === "folderLost" ? folderPaths.get(banner.repoMountId) : undefined,
        );
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

// The banner's one act, where it has one; a lost folder's waits for its path, which its words and
// its refusals name.
function bannerActOf(
  banner: SessionNoticeBanner,
  bridge: PlatformBridge,
  sessionId: string,
  folder: string | undefined,
): SessionBannerAct | undefined {
  switch (banner.kind) {
    case "crashLoop":
      return {
        label: "Restart",
        press: async () => {
          const reply = await callDaemon(bridge, "session.restart", {
            sessionId: heldIdAsWireId<SessionId>(sessionId),
          });
          return reply.status === "refused" ? refusedLine(reply.refusal) : undefined;
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
                (error: unknown) =>
                  refusedLine(coerceToRefusal(error, BANNER_ORIGIN, "file-not-opened")),
              ),
          };
    }
    case "folderLost":
      if (banner.health === "unreachable" || folder === undefined) {
        return undefined;
      }
      // A folder that still holds a repository re-attaches; one that holds none cannot be
      // attached, so another folder is picked in its place.
      return banner.isRepository
        ? { label: "Re-attach", press: () => reattachFolder(bridge, banner.repoMountId, folder) }
        : { label: "Open folder…", press: () => openFolder(bridge) };
  }
}

// Attach the folder the person picks, its path reaching the daemon by main's token for it;
// nothing is sent when the picker is canceled.
async function openFolder(bridge: PlatformBridge): Promise<string | undefined> {
  let picked: PickedFolder | null;
  try {
    picked = await bridge.native.showOpenDialog({ purpose: "pickFolder" });
  } catch (error: unknown) {
    return refusedLine(coerceToRefusal(error, BANNER_ORIGIN, "folder-not-picked"));
  }
  if (picked === null) {
    return undefined;
  }
  const reply = await callDaemon(bridge, "repoMount.attach", { localPath: picked.ref });
  return reply.status === "refused" ? refusedLine(reply.refusal) : undefined;
}
