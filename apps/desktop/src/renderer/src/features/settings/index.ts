export { registerSettingsSurface } from "./contributions/screens.js";
export {
  /** @consumedBy the window's palette commands */
  buildColorSchemeCommands,
} from "./contributions/commands.js";
export {
  /** @consumedBy the window's palette commands */
  useBridgeCommands,
} from "./hooks/useBridgeCommands.js";
export {
  /** @consumedBy the General settings page's crash-reporting block */
  CrashReportingBlock,
} from "./pages/general/components/CrashReportingBlock.js";
