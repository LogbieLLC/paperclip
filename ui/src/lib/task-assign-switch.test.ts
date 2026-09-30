import { describe, expect, it } from "vitest";
import { taskAssignSwitch } from "./task-assign-switch";

describe("taskAssignSwitch", () => {
  it("locks task assignment on for a CEO", () => {
    const state = taskAssignSwitch({
      role: "ceo",
      canCreateAgents: false,
      access: { canAssignTasks: true, taskAssignSource: "ceo_role" },
    });
    expect(state).toMatchObject({ canAssignTasks: true, locked: true });
    expect(state.hint).toBe("Enabled automatically for CEO agents.");
  });

  it("shows a board revoke as off and unlocked, even for a CEO, so the board can turn it back on", () => {
    const state = taskAssignSwitch({
      role: "ceo",
      canCreateAgents: true,
      access: { canAssignTasks: false, taskAssignSource: "revoked" },
    });
    expect(state).toMatchObject({ canAssignTasks: false, locked: false });
    expect(state.hint).toBe("Turned off by a board member. Only a board member can turn it back on.");
  });
});
