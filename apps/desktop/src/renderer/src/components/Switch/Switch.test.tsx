import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Switch } from "./Switch.js";

afterEach(() => {
  cleanup();
});

it("asks for the opposite position once per press, on the switch and on its words", () => {
  const onCheckedChange = vi.fn();
  const { getByRole, getByText } = render(
    <Switch checked={false} onCheckedChange={onCheckedChange} label="On for runs" />,
  );

  fireEvent.click(getByRole("switch", { name: "On for runs" }));
  expect(onCheckedChange.mock.calls).toEqual([[true]]);

  onCheckedChange.mockClear();
  fireEvent.click(getByText("On for runs"));
  expect(onCheckedChange.mock.calls).toEqual([[true]]);
});
