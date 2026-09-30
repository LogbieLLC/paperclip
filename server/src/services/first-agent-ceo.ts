import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, withDedicatedDbConnection } from "@paperclipai/db";
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

/**
 * Runs an agent creation that depends on whether the company still awaits its
 * first agent, so that exactly one agent ever becomes the founding CEO.
 *
 * A company that already has agents takes the fast path with no lock. When the
 * company looks empty, the decision and the insert run while a company-scoped
 * advisory lock is held, and the decision is re-read under that lock. An
 * overlapping first-agent request waits, then sees the committed founder and
 * files its own agent normally. The lock lives on a dedicated connection so the
 * creation work can use the normal pool without starving it.
 */
export async function withFirstAgentDecision<T>(
  db: Db,
  companyId: string,
  create: (isFirstAgent: boolean) => Promise<T>,
): Promise<T> {
  if (!(await companyAwaitsFirstAgent(db, companyId))) return create(false);
  return withDedicatedDbConnection(db, (dedicated) =>
    dedicated.transaction(async (lock) => {
      await lock.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:first-agent-ceo:${companyId}`}, 0))`,
      );
      return create(await companyAwaitsFirstAgent(db, companyId));
    }),
  );
}
