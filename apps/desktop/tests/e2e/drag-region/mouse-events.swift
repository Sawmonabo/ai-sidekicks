// Posts the system's own mouse events at points on the screen, in the screen's top-left-origin
// points, as a person's hand on a trackpad would: through the HID event tap, so the window
// server and the window under the pointer decide what the press does, not the page.
//
//   mouse-events click <x> <y>             one press and release
//   mouse-events double-click <x> <y>      two presses, the second counted as a double click
//   mouse-events drag <x> <y> <dx> <dy>    press, move by (dx, dy) in steps, release
//
// It exits 2 when this process may not post events, naming the permission to grant, and puts
// the pointer back where it found it.

import CoreGraphics
import Foundation

/// The pause between two posted events, long enough for the window server to deliver each.
let stepMicroseconds: useconds_t = 16_000

/// How many moves a drag is cut into.
let dragSteps = 12

func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func post(_ type: CGEventType, at point: CGPoint, clickState: Int64 = 1) {
  guard let event = CGEvent(
    mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
  else {
    fail("CGEvent refused a \(type.rawValue) event at \(point).", code: 1)
  }
  event.setIntegerValueField(.mouseEventClickState, value: clickState)
  event.post(tap: .cghidEventTap)
  usleep(stepMicroseconds)
}

func press(at point: CGPoint, clickState: Int64) {
  post(.leftMouseDown, at: point, clickState: clickState)
  post(.leftMouseUp, at: point, clickState: clickState)
}

func number(_ index: Int) -> CGFloat {
  let arguments = CommandLine.arguments
  guard index < arguments.count, let value = Double(arguments[index]) else {
    fail("Usage: mouse-events click|double-click <x> <y> | drag <x> <y> <dx> <dy>", code: 64)
  }
  return CGFloat(value)
}

guard CGPreflightPostEventAccess() else {
  fail(
    "This process may not post mouse events. Grant the app that runs the test (the terminal or "
      + "editor) Accessibility in System Settings > Privacy & Security > Accessibility.",
    code: 2)
}

let verb = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard ["click", "double-click", "drag"].contains(verb) else {
  fail("Unknown verb \(verb); expected click, double-click or drag.", code: 64)
}
let start = CGPoint(x: number(2), y: number(3))
let offset = verb == "drag" ? CGPoint(x: number(4), y: number(5)) : .zero
let pointerBefore = CGEvent(source: nil)?.location

post(.mouseMoved, at: start)
switch verb {
case "click":
  press(at: start, clickState: 1)
case "double-click":
  press(at: start, clickState: 1)
  press(at: start, clickState: 2)
case "drag":
  post(.leftMouseDown, at: start)
  for step in 1...dragSteps {
    let fraction = CGFloat(step) / CGFloat(dragSteps)
    post(
      .leftMouseDragged,
      at: CGPoint(x: start.x + offset.x * fraction, y: start.y + offset.y * fraction))
  }
  post(.leftMouseUp, at: CGPoint(x: start.x + offset.x, y: start.y + offset.y))
default:
  break
}

if let pointerBefore {
  post(.mouseMoved, at: pointerBefore)
}
