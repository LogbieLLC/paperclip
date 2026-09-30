import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
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

/**
 * Settles who founded the company after an agent was created as its first
 * agent. Two first-agent requests can overlap: each sees an empty company and
 * files its agent as CEO. The earliest root CEO wins; a later one is re-filed
 * under its fallback role and reports to the winner. Every overlapping request
 * runs this after its insert, under one company lock, and orders candidates the
 * same way, so they all agree on the winner. Returns whether this agent was
 * re-filed and the founding CEO's id.
 */
export async function settleFoundingCeo(
  db: Db,
  input: { companyId: string; agentId: string; fallbackRole: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:first-agent-ceo:${input.companyId}`}, 0))`,
    );
    const rootCeos = await tx
      .select({ id: agents.id, metadata: agents.metadata })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, input.companyId),
          eq(agents.role, FIRST_AGENT_ROLE),
          isNull(agents.reportsTo),
          ne(agents.status, "terminated"),
        ),
      )
      .orderBy(asc(agents.createdAt), asc(agents.id));
    const founder = rootCeos.find((row) => !readBuiltInAgentMarker(row.metadata));
    if (!founder || founder.id === input.agentId) return { demoted: false, founderId: input.agentId };
    await tx
      .update(agents)
      .set({ role: input.fallbackRole, reportsTo: founder.id, updatedAt: new Date() })
      .where(eq(agents.id, input.agentId));
    return { demoted: true, founderId: founder.id };
  });
}
