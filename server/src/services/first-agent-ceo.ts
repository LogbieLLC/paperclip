import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

/**
 * The role the first agent in a company is always filed under.
 *
 * A company's first agent is its CEO, whatever the customer named it and
 * whatever role the client sent: the org chart needs a root, and agent join
 * approval needs a CEO for new agents to report to. Without one, a company
 * whose first agent was filed as `general` could never approve an external
 * agent's join request (paperclipai/paperclip#11440).
 */
export const FIRST_AGENT_ROLE = "ceo" as const;

export type FirstAgentCandidate = {
  status: string;
  metadata: unknown;
};

/**
 * Whether an agent created now would be the company's first agent. Terminated
 * agents and bundled built-in helpers (Reflection Coach, Summarizer) do not
 * count: neither can lead the company, so neither stops the next agent from
 * becoming its CEO. An agent still pending board approval does count.
 */
export function isFirstCompanyAgent(existingAgents: FirstAgentCandidate[]): boolean {
  return !existingAgents.some(
    (agent) => agent.status !== "terminated" && !readBuiltInAgentMarker(agent.metadata),
  );
}

export async function companyAwaitsFirstAgent(db: Db, companyId: string): Promise<boolean> {
  const rows = await db
    .select({ status: agents.status, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return isFirstCompanyAgent(rows);
}
