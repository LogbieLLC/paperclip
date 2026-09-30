import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// paperclipai/paperclip#11440: an external agent (OpenClaw) invited into a
// brand-new company could never be approved, because approval required an
// existing CEO to report to and nothing had created one. The first agent to
// join a company is now its CEO. Once a CEO exists it can approve or decline
// further AGENT join requests on the board's behalf, but human join requests
// (which grant board membership) stay with humans.

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping join-request CEO bootstrap route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

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

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId: null, source: "agent_jwt" };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function seedCompany(db: Db) {
  const nonce = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return db
    .insert(companies)
    .values({ name: `Join CEO ${nonce}`, issuePrefix: `JC${nonce}` })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedJoinRequest(
  db: Db,
  companyId: string,
  input: { requestType: "agent" | "human"; agentName?: string; requestingUserId?: string },
) {
  const invite = await db
    .insert(invites)
    .values({
      companyId,
      tokenHash: `hash-${randomUUID()}`,
      allowedJoinTypes: input.requestType,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning()
    .then((rows) => rows[0]!);
  return db
    .insert(joinRequests)
    .values({
      inviteId: invite.id,
      companyId,
      requestType: input.requestType,
      requestIp: "127.0.0.1",
      agentName: input.requestType === "agent" ? (input.agentName ?? "OpenClaw") : null,
      adapterType: input.requestType === "agent" ? "openclaw_gateway" : null,
      requestingUserId: input.requestType === "human" ? (input.requestingUserId ?? "human-1") : null,
      requestEmailSnapshot: input.requestType === "human" ? "human@example.com" : null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function grantKeys(db: Db, companyId: string, agentId: string) {
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

describeEmbeddedPostgres("join request approval bootstraps and empowers the company CEO", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Load the large router graph during setup so a cold transform does not
  // consume the first assertion's timeout budget.
  beforeAll(async () => {
    await import("../routes/access.js");
  }, 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-join-request-ceo-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCeo(companyId: string) {
    const app = await createApp(db, boardActor(companyId));
    const joinRequest = await seedJoinRequest(db, companyId, { requestType: "agent", agentName: "Founding CEO" });
    const res = await request(app).post(`/api/companies/${companyId}/join-requests/${joinRequest.id}/approve`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.createdAgentId as string;
  }

  it("approves the first agent join request into an empty company and makes it the CEO", async () => {
    const company = await seedCompany(db);
    const joinRequest = await seedJoinRequest(db, company.id, { requestType: "agent", agentName: "OpenClaw" });

    const res = await request(await createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/join-requests/${joinRequest.id}/approve`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [created] = await db.select().from(agents).where(eq(agents.id, res.body.createdAgentId));
    expect(created!.name).toBe("OpenClaw");
    expect(created!.role).toBe("ceo");
    expect(created!.reportsTo).toBeNull();
    expect(await grantKeys(db, company.id, created!.id)).toEqual(
      expect.arrayContaining(["agents:configure", "joins:approve", "skills:create", "tasks:assign"]),
    );
  }, 30_000);

  it("files later agent joins as general agents reporting to the CEO", async () => {
    const company = await seedCompany(db);
    const ceoId = await seedCeo(company.id);
    const joinRequest = await seedJoinRequest(db, company.id, { requestType: "agent", agentName: "Worker" });

    const res = await request(await createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/join-requests/${joinRequest.id}/approve`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [created] = await db.select().from(agents).where(eq(agents.id, res.body.createdAgentId));
    expect(created!.role).toBe("general");
    expect(created!.reportsTo).toBe(ceoId);
    expect(await grantKeys(db, company.id, created!.id)).not.toContain("joins:approve");
  }, 30_000);

  it("explains how to recover when agents exist but none of them is the CEO", async () => {
    const company = await seedCompany(db);
    await db.insert(agents).values({ companyId: company.id, name: "Lonely Engineer", role: "engineer", adapterType: "process" });
    const joinRequest = await seedJoinRequest(db, company.id, { requestType: "agent" });

    const res = await request(await createApp(db, boardActor(company.id)))
      .post(`/api/companies/${company.id}/join-requests/${joinRequest.id}/approve`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no active CEO");
    expect(res.body.error).toContain("Promote an existing agent to the CEO role");
  }, 30_000);

  it("lets the CEO approve an agent join request on the board's behalf and records the CEO as the actor", async () => {
    const company = await seedCompany(db);
    const ceoId = await seedCeo(company.id);
    const joinRequest = await seedJoinRequest(db, company.id, { requestType: "agent", agentName: "Researcher" });

    const res = await request(await createApp(db, agentActor(company.id, ceoId)))
      .post(`/api/companies/${company.id}/join-requests/${joinRequest.id}/approve`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("approved");
    const [created] = await db.select().from(agents).where(eq(agents.id, res.body.createdAgentId));
    expect(created!.reportsTo).toBe(ceoId);

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "join.approved"), eq(activityLog.entityId, joinRequest.id)));
    expect(activity!.actorType).toBe("agent");
    expect(activity!.actorId).toBe(ceoId);
    expect(activity!.agentId).toBe(ceoId);
  }, 30_000);

  it("lets the CEO decline an agent join request", async () => {
    const company = await seedCompany(db);
    const ceoId = await seedCeo(company.id);
    const joinRequest = await seedJoinRequest(db, company.id, { requestType: "agent" });

    const res = await request(await createApp(db, agentActor(company.id, ceoId)))
      .post(`/api/companies/${company.id}/join-requests/${joinRequest.id}/reject`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("rejected");
    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "join.rejected"), eq(activityLog.entityId, joinRequest.id)));
    expect(activity!.actorType).toBe("agent");
    expect(activity!.actorId).toBe(ceoId);
  }, 30_000);

  it("never lets an agent approve or decline a human join request", async () => {
    const company = await seedCompany(db);
    const ceoId = await seedCeo(company.id);
    const humanRequest = await seedJoinRequest(db, company.id, { requestType: "human" });
    const app = await createApp(db, agentActor(company.id, ceoId));

    const approve = await request(app)
      .post(`/api/companies/${company.id}/join-requests/${humanRequest.id}/approve`)
      .send({});
    expect(approve.status).toBe(403);
    const reject = await request(app)
      .post(`/api/companies/${company.id}/join-requests/${humanRequest.id}/reject`)
      .send({});
    expect(reject.status).toBe(403);

    const [unchanged] = await db.select().from(joinRequests).where(eq(joinRequests.id, humanRequest.id));
    expect(unchanged!.status).toBe("pending_approval");
    const humanMemberships = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalType, "user")));
    expect(humanMemberships).toHaveLength(0);
  }, 30_000);

  it("shows the CEO only agent join requests, keeping human requester details private", async () => {
    const company = await seedCompany(db);
    const ceoId = await seedCeo(company.id);
    const agentRequest = await seedJoinRequest(db, company.id, { requestType: "agent" });
    await seedJoinRequest(db, company.id, { requestType: "human" });

    const res = await request(await createApp(db, agentActor(company.id, ceoId)))
      .get(`/api/companies/${company.id}/join-requests?status=pending_approval`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([agentRequest.id]);
  }, 30_000);

  it("keeps join approval closed to agents without the joins:approve grant", async () => {
    const company = await seedCompany(db);
    await seedCeo(company.id);
    const [worker] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process" })
      .returning();
    const joinRequest = await seedJoinRequest(db, company.id, { requestType: "agent" });

    const res = await request(await createApp(db, agentActor(company.id, worker!.id)))
      .post(`/api/companies/${company.id}/join-requests/${joinRequest.id}/approve`)
      .send({});

    expect(res.status).toBe(403);
  }, 30_000);
});
