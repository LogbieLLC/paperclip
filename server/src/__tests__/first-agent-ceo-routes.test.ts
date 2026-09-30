import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalService } from "../services/approvals.js";
import { BUILT_IN_AGENT_METADATA_KEY } from "../services/built-in-agent-metadata.js";
import { isFirstCompanyAgent } from "../services/first-agent-ceo.js";

// The first agent a company gets is its CEO, whatever the customer named it
// and whatever role the client sent. Without a CEO the company cannot approve
// agent join requests (paperclipai/paperclip#11440), and the org chart has no
// root. These tests pin that invariant on every server path that creates an
// agent row for a board actor.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping first-agent CEO route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const ROOT_CEO_GRANT_KEYS = ["agents:configure", "joins:approve", "skills:create", "tasks:assign"];

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

async function seedCompany(db: Db, options: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `First CEO Co ${nonce}`,
      issuePrefix: `FC${nonce.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: options.requireBoardApprovalForNewAgents ?? false,
    })
    .returning();
  return company!;
}

async function agentGrantKeys(db: Db, companyId: string, agentId: string) {
  const rows = await db
    .select({ permissionKey: principalPermissionGrants.permissionKey })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
      ),
    );
  return rows.map((row) => row.permissionKey).sort();
}

describe("isFirstCompanyAgent", () => {
  it("is true for a company with no agents", () => {
    expect(isFirstCompanyAgent([])).toBe(true);
  });

  it("ignores terminated agents", () => {
    expect(isFirstCompanyAgent([{ status: "terminated", metadata: null }])).toBe(true);
  });

  it("ignores built-in helper agents", () => {
    expect(
      isFirstCompanyAgent([
        {
          status: "idle",
          metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "reflection-coach", featureKeys: [] } },
        },
      ]),
    ).toBe(true);
  });

  it("is false once a regular agent exists, including one pending approval", () => {
    expect(isFirstCompanyAgent([{ status: "idle", metadata: null }])).toBe(false);
    expect(isFirstCompanyAgent([{ status: "pending_approval", metadata: null }])).toBe(false);
  });
});

describeEmbeddedPostgres("first agent in a company becomes the CEO", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-first-agent-ceo-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("files the onboarding hire as CEO even when the wizard sends role general", async () => {
    const company = await seedCompany(db);
    const res = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({
        name: "Ada",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        onboardingFirstAgent: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.name).toBe("Ada");
    expect(res.body.agent.role).toBe("ceo");
    expect(res.body.agent.reportsTo).toBeNull();
    expect(await agentGrantKeys(db, company.id, res.body.agent.id)).toEqual(ROOT_CEO_GRANT_KEYS);
  }, 30_000);

  it("makes the first agent CEO on the direct create path, whatever it is named", async () => {
    const company = await seedCompany(db);
    const res = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "Engineer Bob", role: "engineer", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.role).toBe("ceo");
    expect(res.body.reportsTo).toBeNull();
    expect(await agentGrantKeys(db, company.id, res.body.id)).toEqual(ROOT_CEO_GRANT_KEYS);
  }, 30_000);

  it("treats a company whose only agents are terminated or built-in as having no first agent yet", async () => {
    const company = await seedCompany(db);
    await db.insert(agents).values([
      { companyId: company.id, name: "Old CEO", role: "ceo", status: "terminated", adapterType: "process" },
      {
        companyId: company.id,
        name: "Reflection Coach",
        role: "general",
        adapterType: "process",
        metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "reflection-coach", featureKeys: [] } },
      },
    ]);

    const res = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Grace", role: "general", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.role).toBe("ceo");
  }, 30_000);

  it("leaves later hires with the role they asked for, reporting where they asked", async () => {
    const company = await seedCompany(db);
    const [ceo] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Existing CEO", role: "ceo", adapterType: "process" })
      .returning();

    const res = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Eng", role: "engineer", reportsTo: ceo!.id, adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.role).toBe("engineer");
    expect(res.body.agent.reportsTo).toBe(ceo!.id);
    expect(await agentGrantKeys(db, company.id, res.body.agent.id)).not.toContain("joins:approve");
  }, 30_000);

  it("records CEO on a pending first hire and grants the CEO permissions once the board approves", async () => {
    const company = await seedCompany(db, { requireBoardApprovalForNewAgents: true });
    const res = await request(createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Lin", role: "general", adapterType: "process", adapterConfig: {}, onboardingFirstAgent: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.status).toBe("pending_approval");
    expect(res.body.agent.role).toBe("ceo");
    expect(res.body.approval.payload.role).toBe("ceo");

    await approvalService(db).approve(res.body.approval.id, "board-user", "Approved during onboarding.");

    const [approved] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
    expect(approved!.status).toBe("idle");
    expect(approved!.role).toBe("ceo");
    expect(await agentGrantKeys(db, company.id, res.body.agent.id)).toEqual(ROOT_CEO_GRANT_KEYS);
  }, 30_000);
});
