/** The words naming the position a switch ships in, as a changed mark's tooltip reads them. */
export function describeSwitchDefault(isOnByDefault: boolean): "On by default" | "Off by default" {
  return isOnByDefault ? "On by default" : "Off by default";
}
