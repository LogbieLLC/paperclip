import type { AgentAccessState } from "@paperclipai/shared";

type TaskAssignAccess = Partial<Pick<AgentAccessState, "canAssignTasks" | "taskAssignSource">>;

/**
 * State of the agent page's "Can assign tasks" switch.
 *
 * A CEO or an agent that can create agents assigns tasks by role, so the
 * switch is locked on. A board member's revoke overrides that: the switch
 * shows off and unlocks, so only a board member's click turns it back on and
 * no other switch brings it back.
 */
export function taskAssignSwitch(agent: {
  role: string;
  canCreateAgents: boolean;
  access?: TaskAssignAccess | null;
}) {
  const canAssignTasks = Boolean(agent.access?.canAssignTasks);
  const source = agent.access?.taskAssignSource ?? "none";
  const revoked = source === "revoked";
  const hint =
    source === "revoked"
      ? "Turned off by a board member. Only a board member can turn it back on."
      : source === "ceo_role"
        ? "Enabled automatically for CEO agents."
        : source === "agent_creator"
          ? "Enabled automatically while this agent can create new agents."
          : source === "explicit_grant"
            ? "Enabled via explicit organization permission grant."
            : source === "simple_default"
              ? "Enabled by simple organization-wide task assignment defaults."
              : "Disabled unless explicitly granted.";
  return {
    canAssignTasks,
    locked: !revoked && (agent.role === "ceo" || agent.canCreateAgents),
    hint,
    /** `canAssignTasks` to send when agent creation is switched on. */
    valueWhenEnablingAgentCreation: revoked ? canAssignTasks : true,
  };
}
