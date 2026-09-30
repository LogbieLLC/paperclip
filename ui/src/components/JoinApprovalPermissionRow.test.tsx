// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JoinApprovalPermissionRow } from "./JoinApprovalPermissionRow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(props: Parameters<typeof JoinApprovalPermissionRow>[0]) {
  flushSync(() => {
    root.render(<JoinApprovalPermissionRow {...props} />);
  });
  return container.querySelector('[role="switch"]') as HTMLButtonElement;
}

it("shows join approval as on when the agent holds the joins:approve grant", () => {
  const toggle = render({
    grants: [{ permissionKey: "tasks:assign" }, { permissionKey: "joins:approve" }],
    disabled: false,
    onChange: vi.fn(),
  });
  expect(container.textContent).toContain("Can approve agent join requests");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

it("shows join approval as off when the grant is missing", () => {
  const toggle = render({ grants: [{ permissionKey: "tasks:assign" }], disabled: false, onChange: vi.fn() });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("asks to turn join approval off when the board switches it off", () => {
  const onChange = vi.fn();
  const toggle = render({ grants: [{ permissionKey: "joins:approve" }], disabled: false, onChange });
  flushSync(() => {
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith(false);
});

it("explains that human join requests stay with the board", () => {
  render({ grants: [], disabled: false, onChange: vi.fn() });
  expect(container.textContent).toContain("Human join requests always need a board member");
});

it("cannot be changed while a permission update is saving", () => {
  const toggle = render({ grants: [{ permissionKey: "joins:approve" }], disabled: true, onChange: vi.fn() });
  expect(toggle.disabled).toBe(true);
});
