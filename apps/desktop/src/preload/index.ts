// Electron preload: the expose calls alone.
//
// `contextBridge.exposeInMainWorld` is the only renderer-visible API: no `ipcRenderer`, no
// `require`, no `process` and no Node built-in. The preload runs sandboxed (`sandbox: true`
// is locked by `src/main/windows/window.ts`), and no auth material reaches
// `window.desktopBridge`, which `src/shared/preload-api.test-d.ts` enforces on the type.

import { contextBridge } from "electron";

import { FIXTURE_LAUNCH_GLOBAL, readFixtureLaunchSwitches } from "@shared/fixture-launch.js";
import { preloadApi } from "./api.js";

// Substituted by the `define` block in `electron.vite.config.ts`: `true` in the development
// and fixtures builds, `false` in the release build, which folds the branch below away.
declare const __FIXTURE_BUILD__: boolean;

contextBridge.exposeInMainWorld("desktopBridge", preloadApi);

// A fixture launch reaches the page on a global of its own rather than on `desktopBridge`,
// so the product bridge's contract carries no fixture member. Main passed it as renderer
// switches after checking it against the scenario catalog; a window started without one
// gets no global.
if (__FIXTURE_BUILD__) {
  const fixtureLaunch = readFixtureLaunchSwitches(process.argv);
  if (fixtureLaunch !== undefined) {
    contextBridge.exposeInMainWorld(FIXTURE_LAUNCH_GLOBAL, fixtureLaunch);
  }
}
