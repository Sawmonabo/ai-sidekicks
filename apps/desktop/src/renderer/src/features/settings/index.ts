export { registerSettingsSurface } from "./contributions/screens.js";
export { buildColorSchemeCommand } from "./contributions/commands.js";
export {
  /** @consumedBy the window's palette commands */
  useBridgeCommands,
} from "./hooks/useBridgeCommands.js";
export {
  /** @consumedBy the General settings page's crash-reporting block */
  CrashReportingBlock,
} from "./pages/general/components/CrashReportingBlock.js";
