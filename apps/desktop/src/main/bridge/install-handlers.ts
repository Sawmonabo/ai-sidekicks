// Every channel answers only the app's own renderer documents: the asking frame must be on an
// origin an app window may navigate within. Any other frame is refused before its request is
// read; this is a backstop, as only a navigation the policy failed to stop could put another
// origin in a window.

import path from "node:path";

import {
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { getNotificationStatus } from "notify-status";

import {
  BRIDGE_CHANNELS,
  OPEN_DAEMON_SUBSCRIPTION_CHANNEL,
  type InvokedBridgeChannel,
  type UpdaterBridgeChannel,
} from "#shared/bridge-channels.js";
import type { DaemonSubscriptionOpening } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { describeFailure } from "#shared/failure-message.js";
import type { OpenDialogPurpose, OpenDialogResults } from "#shared/preload-api.js";
import { classifyNavigation, inWindowOrigins, openExternalUrl } from "../windows/navigation.js";
import type { DaemonLink } from "../services/daemon/link/status.js";
import type { DaemonSupervisor } from "../services/daemon/supervisor.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import type { DaemonForwarding } from "./daemon.js";
import type { FilePathRefs } from "./file-path/refs.js";
import { KEYBOARD_MAP_FILE_NAME, KeyboardMapFile, parseKeyboardMap } from "./keyboard-map-file.js";
import { copyToClipboard } from "./native/clipboard.js";
import { listEditors } from "./native/editors/installed.js";
import { openInEditor, parseEditorOpenRequest, readChosenEditorId } from "./native/editors/open.js";
import { runProgram } from "./native/editors/program-runner.js";
import { installedEditorsFor } from "./native/editors/platform.js";
import { machineSettingsAnswers } from "./machine-settings.js";
import { refForDroppedFile, type PastedImages } from "./native/file-intake.js";
import { readNotificationPermission } from "./native/notification-permission.js";
import { showOpenDialog } from "./native/open-dialog.js";
import { pageSafeFailure, pageSafeMessage } from "./page-safe-message.js";
import { type ChannelAnswer, windowAnswers, type WindowHandlerContext } from "./window.js";

/** The channels main answers: every channel the preload invokes but the updater's. */
type AnsweredChannel = Exclude<InvokedBridgeChannel, UpdaterBridgeChannel>;

/** What main's bridge answers are built over. */
export interface BridgeHandlerServices {
  /** Main's own folder under the profile, `app.getPath("userData")`. */
  readonly userData: string;
  readonly daemonForwarding: DaemonForwarding;
  /** Main's one table of the file tokens it handed the pages, the one the daemon relay reads. */
  readonly filePathRefs: FilePathRefs;
  /** The pictures pasted into the composer, the ones the daemon relay removes once copied. */
  readonly pastedImages: PastedImages;
  readonly supervisor: Pick<DaemonSupervisor, "requestStart">;
  readonly daemonLink: Pick<DaemonLink, "client">;
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly windowContext: WindowHandlerContext;
}

/**
 * Register every bridge member main answers, on the channels `BRIDGE_MEMBER_CHANNELS` names for
 * it. Called once, after ready, before any window.
 */
export function installBridgeHandlers(services: BridgeHandlerServices): void {
  const {
    userData,
    daemonForwarding,
    filePathRefs,
    pastedImages,
    supervisor,
    daemonLink,
    log,
    windowContext,
  } = services;
  const keyboardMapFile = new KeyboardMapFile({
    filePath: path.join(userData, KEYBOARD_MAP_FILE_NAME),
    now: () => new Date(),
  });

  // A synchronous channel answers through `returnValue` and must always set it, or the page
  // waits forever, so a refused frame and a failed opening get an answer rather than a throw.
  ipcMain.on(OPEN_DAEMON_SUBSCRIPTION_CHANNEL, (event, request: unknown) => {
    let opening: DaemonSubscriptionOpening;
    if (!isAppRendererFrame(event)) {
      opening = {
        outcome: "failed",
        message: refusedFrameMessage(OPEN_DAEMON_SUBSCRIPTION_CHANNEL),
      };
    } else {
      try {
        opening = daemonForwarding.open(event.sender, request);
      } catch (failure) {
        recordFailure(log, OPEN_DAEMON_SUBSCRIPTION_CHANNEL, failure);
        opening = {
          outcome: "failed",
          message: pageSafeMessage(failure, NOT_ANSWERING_MESSAGE),
        };
      }
    }
    event.returnValue = opening;
  });
  // Keyed by every answered channel, so one with no answer fails the build.
  const answers: Readonly<Record<AnsweredChannel, ChannelAnswer>> = {
    [BRIDGE_CHANNELS.daemonCall]: (event, request) => daemonForwarding.call(event.sender, request),
    [BRIDGE_CHANNELS.closeDaemonSubscription]: (event, subscriptionId) => {
      daemonForwarding.close(event.sender, subscriptionId);
    },
    [BRIDGE_CHANNELS.requestDaemonStart]: () => {
      supervisor.requestStart();
    },
    [BRIDGE_CHANNELS.showOpenDialog]: (
      event,
      options,
    ): Promise<OpenDialogResults[OpenDialogPurpose]> =>
      showOpenDialog(
        {
          // Sheeted on the window the person used last, the one they asked from.
          showOpenDialog: (dialogOptions) => {
            const owner = windowContext.openWindows.windowUsedLast();
            return owner === undefined
              ? dialog.showOpenDialog(dialogOptions)
              : dialog.showOpenDialog(owner, dialogOptions);
          },
        },
        filePathRefs,
        event.sender,
        options,
      ),
    [BRIDGE_CHANNELS.getDroppedFileRef]: (event, droppedPath) =>
      refForDroppedFile(filePathRefs, event.sender, droppedPath),
    [BRIDGE_CHANNELS.savePastedImage]: (event, bytes) => pastedImages.save(event.sender, bytes),
    [BRIDGE_CHANNELS.openExternal]: (_event, url) => {
      if (typeof url !== "string") {
        throw new TypeError("An outside address is a string.");
      }
      return openExternalUrl(url);
    },
    [BRIDGE_CHANNELS.openInEditor]: async (event, request) => {
      const { ref, line } = parseEditorOpenRequest(request);
      const targetPath = filePathRefs.requirePath(event.sender, ref, "open");
      await openInEditor(
        {
          installedEditors: () => installedEditorsFor(process.platform, runProgram),
          runProgram,
          openWithSystemDefault: async (systemTarget) => {
            // `openPath` answers a failure as a fixed message naming no path; it never rejects.
            const failure = await shell.openPath(systemTarget);
            if (failure !== "") {
              throw new Error(failure);
            }
          },
        },
        { targetPath, line, editorId: await readChosenEditorId(daemonLink) },
      );
    },
    // Built at each call, so a platform whose form is not built refuses the call alone.
    [BRIDGE_CHANNELS.listEditors]: () =>
      listEditors(installedEditorsFor(process.platform, runProgram)),
    [BRIDGE_CHANNELS.getNotificationPermission]: () =>
      readNotificationPermission(getNotificationStatus),
    [BRIDGE_CHANNELS.copyToClipboard]: (_event, content) =>
      copyToClipboard(
        { write: (flavors) => clipboard.write([new ClipboardItem({ ...flavors })]) },
        content,
      ),
    [BRIDGE_CHANNELS.revealInFileExplorer]: (event, ref) => {
      shell.showItemInFolder(filePathRefs.requirePath(event.sender, ref, "open"));
    },
    [BRIDGE_CHANNELS.readKeyboardMap]: () => keyboardMapFile.read(),
    [BRIDGE_CHANNELS.writeKeyboardMap]: (_event, map) =>
      keyboardMapFile.write(parseKeyboardMap(map)),
    ...machineSettingsAnswers(daemonForwarding),
    ...windowAnswers(windowContext),
  };
  for (const channel of Object.keys(answers) as AnsweredChannel[]) {
    handleFromAppRenderer(channel, answers[channel], log);
  }
}

/**
 * Whether the frame that sent a request is one of the app's own renderer documents. A frame that
 * has navigated away or been torn down has no URL to judge and is refused with the rest.
 */
function isAppRendererFrame(event: Pick<IpcMainInvokeEvent, "senderFrame">): boolean {
  const frameUrl = event.senderFrame?.url;
  return (
    frameUrl !== undefined && classifyNavigation(frameUrl, inWindowOrigins()).kind === "in-window"
  );
}

// A failure is logged whole and crosses with no path, program or code in its message.
function handleFromAppRenderer(
  channel: AnsweredChannel,
  answer: ChannelAnswer,
  log: BridgeHandlerServices["log"],
): void {
  ipcMain.handle(channel, async (event, request: unknown) => {
    if (!isAppRendererFrame(event)) {
      throw new Error(refusedFrameMessage(channel));
    }
    try {
      return await answer(event, request);
    } catch (failure) {
      recordFailure(log, channel, failure);
      throw pageSafeFailure(failure);
    }
  });
}

function recordFailure(log: BridgeHandlerServices["log"], channel: string, failure: unknown): void {
  log.write({
    level: "warning",
    source: "main/bridge",
    message: `${channel} failed: ${describeFailure(failure)}`,
  });
}

function refusedFrameMessage(channel: string): string {
  return `${channel} answers only the app's own renderer documents.`;
}
