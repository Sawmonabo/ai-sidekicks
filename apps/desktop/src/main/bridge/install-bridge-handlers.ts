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
} from "@shared/bridge-channels.js";
import type { DaemonSubscriptionOpening } from "@shared/daemon-forwarding.js";
import type { OpenDialogPurpose, OpenDialogResults } from "@shared/preload-api.js";
import { classifyNavigation, inWindowOrigins, openExternalUrl } from "../windows/navigation.js";
import type { DaemonLink } from "../services/daemon/daemon-link.js";
import type { DaemonSupervisor } from "../services/daemon/daemon-supervisor.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import type { DaemonForwarding } from "./daemon.js";
import type { FilePathRefs } from "./file-path-refs.js";
import { KEYBOARD_MAP_FILE_NAME, KeyboardMapFile, parseKeyboardMap } from "./keyboard-map-file.js";
import { copyToClipboard } from "./native/clipboard.js";
import { listEditors } from "./native/editors/installed-editors.js";
import {
  openInEditor,
  parseEditorOpenRequest,
  readChosenEditorId,
} from "./native/editors/open-in-editor.js";
import { runProgram } from "./native/editors/program-runner.js";
import { installedEditorsFor } from "./native/editors/system-installed-editors.js";
import { machineSettingsAnswers } from "./machine-settings.js";
import { PastedImages, refForDroppedFile } from "./native/file-intake.js";
import { readNotificationPermission } from "./native/notification-permission.js";
import { showOpenDialog } from "./native/open-dialog.js";
import { windowAnswers, type WindowHandlerContext } from "./window-handlers.js";

/** One channel's answer, given the asking event and the one request it carried. */
type ChannelAnswer = (event: IpcMainInvokeEvent, request: unknown) => unknown;

/** Main's folder for pasted pictures, under the profile. */
const PASTED_IMAGES_FOLDER_NAME = "pasted-images";

/** What main's bridge answers are built over. */
export interface BridgeHandlerServices {
  /** Main's own folder under the profile, `app.getPath("userData")`. */
  readonly userData: string;
  readonly daemonForwarding: DaemonForwarding;
  /** Main's one table of the file tokens it handed the pages, the one the daemon relay reads. */
  readonly filePathRefs: FilePathRefs;
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
  const { userData, daemonForwarding, filePathRefs, supervisor, daemonLink, log, windowContext } =
    services;
  const pastedImages = new PastedImages({
    folder: path.join(userData, PASTED_IMAGES_FOLDER_NAME),
    filePathRefs,
    log,
    now: () => new Date(),
  });
  const keyboardMapFile = new KeyboardMapFile({
    filePath: path.join(userData, KEYBOARD_MAP_FILE_NAME),
    now: () => new Date(),
  });

  // A synchronous channel answers through `returnValue` and must always set it, or the page
  // waits forever, so a refused frame gets an answer rather than a throw.
  ipcMain.on(OPEN_DAEMON_SUBSCRIPTION_CHANNEL, (event, request: unknown) => {
    const opening: DaemonSubscriptionOpening = isAppRendererFrame(event)
      ? daemonForwarding.open(event.sender, request)
      : { outcome: "failed", message: refusedFrameMessage(OPEN_DAEMON_SUBSCRIPTION_CHANNEL) };
    event.returnValue = opening;
  });
  // Keyed by every channel main invokes on, so a channel with no answer fails the build.
  const answers: Readonly<Record<InvokedBridgeChannel, ChannelAnswer>> = {
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
          showOpenDialog: (dialogOptions) => {
            const owner = windowContext.openWindows.windowShowing(event.sender);
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
      const targetPath = filePathRefs.requirePath(event.sender, ref);
      await openInEditor(
        {
          installedEditors: () => installedEditorsFor(process.platform, runProgram),
          runProgram,
          openWithSystemDefault: async (systemTarget) => {
            // `openPath` answers its failure as a message rather than rejecting.
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
      shell.showItemInFolder(filePathRefs.requirePath(event.sender, ref));
    },
    [BRIDGE_CHANNELS.readKeyboardMap]: () => keyboardMapFile.read(),
    [BRIDGE_CHANNELS.writeKeyboardMap]: (_event, map) =>
      keyboardMapFile.write(parseKeyboardMap(map)),
    ...machineSettingsAnswers(daemonForwarding),
    ...windowAnswers(windowContext),
  };
  for (const [channel, answer] of Object.entries(answers)) {
    handleFromAppRenderer(channel, answer);
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

function handleFromAppRenderer(channel: string, answer: ChannelAnswer): void {
  ipcMain.handle(channel, (event, request: unknown) => {
    if (!isAppRendererFrame(event)) {
      throw new Error(refusedFrameMessage(channel));
    }
    return answer(event, request);
  });
}

function refusedFrameMessage(channel: string): string {
  return `${channel} answers only the app's own renderer documents.`;
}
