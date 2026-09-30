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
  principalPermissionGrants,
  principalPermissionRevocations,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// When a person revokes a permission, the server must never give it back on
// its own. Revoking deletes the grant row, and the server re-applies default
// grants in several places (root-CEO and built-in agent defaults, the startup
// backfill of human role defaults, invite replays, plugins, imports). Each of
// those must respect the revocation; only an explicit grant by a person may
// restore the permission.

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
    `Skipping permission revocation durability tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const BOARD_USER_ID = "board-owner";

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: BOARD_USER_ID,
    source: "local_implicit",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
  };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const [{ accessRoutes }, { agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
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
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("a revoked permission stays revoked", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await Promise.all([import("../routes/access.js"), import("../routes/agents.js")]);
  }, 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-permission-revocations-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionRevocations);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function services() {
    const [{ accessService }, { builtInAgentService, reconcileBuiltInAgentsOnStartup }, compat] = await Promise.all([
      import("../services/access.js"),
      import("../services/built-in-agents.js"),
      import("../services/principal-access-compatibility.js"),
    ]);
    return { access: accessService(db), builtIns: builtInAgentService(db), reconcileBuiltInAgentsOnStartup, compat };
  }

  async function seedCompany() {
    const nonce = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    const company = await db
      .insert(companies)
      .values({ name: `Revocations ${nonce}`, issuePrefix: `RV${nonce}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    return company;
  }

  async function seedRootCeo(companyId: string) {
    const { access, builtIns } = await services();
    const [ceo] = await db
      .insert(agents)
      .values({ companyId, name: "CEO", role: "ceo", adapterType: "process" })
      .returning();
    await access.ensureMembership(companyId, "agent", ceo!.id, "member", "active");
    await access.setPrincipalPermission(companyId, "agent", ceo!.id, "tasks:assign", true, null);
    await builtIns.ensureCompanyDefaultAgentGrants(companyId);
    return ceo!;
  }

  async function seedHumanMember(companyId: string, membershipRole: string) {
    const { compat } = await services();
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
    await compat.ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole,
      grantedByUserId: null,
    });
    return userId;
  }

  async function grantKeys(companyId: string, principalType: PrincipalType, principalId: string) {
    const rows = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      );
    return rows.map((row) => row.permissionKey).sort();
  }

  async function memberId(companyId: string, principalType: PrincipalType, principalId: string) {
    const [membership] = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      );
    return membership!.id;
  }

  /** The board edits a member's grants the way the Members page does. */
  async function boardSetsGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    keys: string[],
  ) {
    const res = await request(await createApp(db, boardActor(companyId)))
      .patch(`/api/companies/${companyId}/members/${await memberId(companyId, principalType, principalId)}/permissions`)
      .send({ grants: keys.map((permissionKey) => ({ permissionKey, scope: null })) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function boardRevokes(companyId: string, principalType: PrincipalType, principalId: string, key: string) {
    const current = await grantKeys(companyId, principalType, principalId);
    expect(current).toContain(key);
    await boardSetsGrants(companyId, principalType, principalId, current.filter((entry) => entry !== key));
  }

  it("keeps a root CEO's revoked joins:approve revoked when the server re-applies CEO defaults", async () => {
    const { builtIns, reconcileBuiltInAgentsOnStartup } = await services();
    const company = await seedCompany();
    const ceo = await seedRootCeo(company.id);

    // The board turns off the CEO's join approval on the agent page.
    const res = await request(await createApp(db, boardActor(company.id)))
      .patch(`/api/agents/${ceo.id}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: true, canApproveJoins: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await grantKeys(company.id, "agent", ceo.id)).not.toContain("joins:approve");

    // Every automatic path that applies root-CEO defaults: agent create/hire,
    // hire approval, join approval, and server startup.
    await builtIns.ensureCompanyDefaultAgentGrants(company.id);
    await reconcileBuiltInAgentsOnStartup(db);

    const keys = await grantKeys(company.id, "agent", ceo.id);
    expect(keys).not.toContain("joins:approve");
    expect(keys).toEqual(expect.arrayContaining(["agents:configure", "skills:create", "tasks:assign"]));
  }, 60_000);

  it("keeps a revoked human role-default grant revoked across the startup backfill and login sync", async () => {
    const { compat } = await services();
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");

    await boardRevokes(company.id, "user", adminId, "users:invite");

    await compat.backfillPrincipalAccessCompatibility(db);
    await compat.ensureHumanRoleDefaultGrants(db, {
      companyId: company.id,
      principalId: adminId,
      membershipRole: "admin",
      grantedByUserId: null,
    });

    const keys = await grantKeys(company.id, "user", adminId);
    expect(keys).not.toContain("users:invite");
    expect(keys).toContain("tasks:assign");
  }, 30_000);

  it("denies a revoked tools permission even though the admin role would allow it by default", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");
    expect(await access.canUser(company.id, adminId, "tools:admin")).toBe(true);

    await boardRevokes(company.id, "user", adminId, "tools:admin");

    expect(await access.canUser(company.id, adminId, "tools:admin")).toBe(false);
  }, 30_000);

  it("does not let an automatic grant replace (invite replay, plugin) bring a revoked permission back", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");
    await boardRevokes(company.id, "user", adminId, "joins:approve");

    await access.setPrincipalGrants(
      company.id,
      "user",
      adminId,
      [
        { permissionKey: "joins:approve" as PermissionKey, scope: null },
        { permissionKey: "tasks:assign" as PermissionKey, scope: null },
      ],
      null,
    );

    expect(await grantKeys(company.id, "user", adminId)).toEqual(["tasks:assign"]);
  }, 30_000);

  it("does not let an automatic single grant (defaults, imports) bring a revoked permission back", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");
    await boardRevokes(company.id, "user", adminId, "skills:create");

    await access.setPrincipalPermission(company.id, "user", adminId, "skills:create", true, null);

    expect(await grantKeys(company.id, "user", adminId)).not.toContain("skills:create");
  }, 30_000);

  it("records who revoked the permission", async () => {
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");

    await boardRevokes(company.id, "user", adminId, "users:invite");

    const revocations = await db
      .select()
      .from(principalPermissionRevocations)
      .where(eq(principalPermissionRevocations.principalId, adminId));
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      companyId: company.id,
      principalType: "user",
      permissionKey: "users:invite",
      revokedByActorType: "user",
      revokedByActorId: BOARD_USER_ID,
    });
  }, 30_000);

  it("lets a board member grant a revoked permission back explicitly, and then keeps it", async () => {
    const { compat } = await services();
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");
    await boardRevokes(company.id, "user", adminId, "users:invite");

    const current = await grantKeys(company.id, "user", adminId);
    await boardSetsGrants(company.id, "user", adminId, [...current, "users:invite"]);
    await compat.backfillPrincipalAccessCompatibility(db);

    expect(await grantKeys(company.id, "user", adminId)).toContain("users:invite");
    const revocations = await db
      .select()
      .from(principalPermissionRevocations)
      .where(eq(principalPermissionRevocations.principalId, adminId));
    expect(revocations).toHaveLength(0);
  }, 30_000);

  it("never lets the CEO switch join approval back on for itself or any agent", async () => {
    const company = await seedCompany();
    const ceo = await seedRootCeo(company.id);
    const boardApp = await createApp(db, boardActor(company.id));
    const off = await request(boardApp)
      .patch(`/api/agents/${ceo.id}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: true, canApproveJoins: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    const ceoApp = await createApp(db, {
      type: "agent",
      agentId: ceo.id,
      companyId: company.id,
      runId: null,
      source: "agent_jwt",
    });
    const selfGrant = await request(ceoApp)
      .patch(`/api/agents/${ceo.id}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: true, canApproveJoins: true });
    expect(selfGrant.status).toBe(403);
    expect(await grantKeys(company.id, "agent", ceo.id)).not.toContain("joins:approve");
  }, 60_000);

  it("does not let the CEO restore a permission the board revoked from one of its reports", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const ceo = await seedRootCeo(company.id);
    const [worker] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Worker", role: "engineer", reportsTo: ceo.id, adapterType: "process", permissions: { canCreateAgents: false } })
      .returning();
    await access.ensureMembership(company.id, "agent", worker!.id, "member", "active");
    await access.setPrincipalPermission(company.id, "agent", worker!.id, "tasks:assign", true, null);

    const off = await request(await createApp(db, boardActor(company.id)))
      .patch(`/api/agents/${worker!.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    const ceoOn = await request(await createApp(db, {
      type: "agent",
      agentId: ceo.id,
      companyId: company.id,
      runId: null,
      source: "agent_jwt",
    }))
      .patch(`/api/agents/${worker!.id}/permissions`)
      .send({ canCreateAgents: false, canCreateSkills: false, canAssignTasks: true });
    // Refused outright, not reported as a success, and nothing else changes.
    expect(ceoOn.status, JSON.stringify(ceoOn.body)).toBe(403);
    expect(await grantKeys(company.id, "agent", worker!.id)).not.toContain("tasks:assign");
    const [after] = await db.select().from(agents).where(eq(agents.id, worker!.id));
    expect((after!.permissions as Record<string, unknown>).canCreateSkills).not.toBe(false);
  }, 60_000);

  it("keeps a CEO's revoked task assignment revoked when the board changes another of its permissions", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const ceo = await seedRootCeo(company.id);
    await access.setPrincipalPermission(company.id, "agent", ceo.id, "tasks:assign", false, BOARD_USER_ID, null, {
      decidedBy: { actorType: "user", actorId: BOARD_USER_ID },
    });

    const app = await createApp(db, boardActor(company.id));

    // The agent page shows the revoke, so the switch is off and unlocked...
    const shown = await request(app).get(`/api/agents/${ceo.id}`);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.access).toMatchObject({ canAssignTasks: false, taskAssignSource: "revoked" });

    // ...and every other switch sends that state, here "Can create/import skills".
    const res = await request(app)
      .patch(`/api/agents/${ceo.id}/permissions`)
      .send({ canCreateAgents: true, canCreateSkills: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await grantKeys(company.id, "agent", ceo.id)).not.toContain("tasks:assign");
    expect(res.body.access).toMatchObject({ canAssignTasks: false, taskAssignSource: "revoked" });
  }, 60_000);

  it("leaves task assignment alone when a permission update does not name it", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const ceo = await seedRootCeo(company.id);
    await access.setPrincipalPermission(company.id, "agent", ceo.id, "tasks:assign", false, BOARD_USER_ID, null, {
      decidedBy: { actorType: "user", actorId: BOARD_USER_ID },
    });
    const [worker] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Worker", role: "engineer", reportsTo: ceo.id, adapterType: "process", permissions: { canCreateAgents: false } })
      .returning();
    await access.ensureMembership(company.id, "agent", worker!.id, "member", "active");
    await access.setPrincipalPermission(company.id, "agent", worker!.id, "tasks:assign", true, BOARD_USER_ID, null, {
      decidedBy: { actorType: "user", actorId: BOARD_USER_ID },
    });
    const app = await createApp(db, boardActor(company.id));

    // Only the task assignment switch sends canAssignTasks, so a page loaded
    // before a revoke cannot undo it, and other switches cannot revoke it.
    const ceoEdit = await request(app)
      .patch(`/api/agents/${ceo.id}/permissions`)
      .send({ canCreateAgents: true, canCreateSkills: false });
    expect(ceoEdit.status, JSON.stringify(ceoEdit.body)).toBe(200);
    expect(await grantKeys(company.id, "agent", ceo.id)).not.toContain("tasks:assign");

    const workerEdit = await request(app)
      .patch(`/api/agents/${worker!.id}/permissions`)
      .send({ canCreateAgents: false, canCreateSkills: false });
    expect(workerEdit.status, JSON.stringify(workerEdit.body)).toBe(200);
    expect(await grantKeys(company.id, "agent", worker!.id)).toContain("tasks:assign");
  }, 60_000);

  it("lets a board member turn a CEO's revoked task assignment back on from the agent page", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const ceo = await seedRootCeo(company.id);
    await access.setPrincipalPermission(company.id, "agent", ceo.id, "tasks:assign", false, BOARD_USER_ID, null, {
      decidedBy: { actorType: "user", actorId: BOARD_USER_ID },
    });

    const res = await request(await createApp(db, boardActor(company.id)))
      .patch(`/api/agents/${ceo.id}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await grantKeys(company.id, "agent", ceo.id)).toContain("tasks:assign");
    expect(res.body.access).toMatchObject({ canAssignTasks: true, taskAssignSource: "ceo_role" });
  }, 60_000);

  it("keeps an agent's task assignment revoked when the board turns it off on the agent page", async () => {
    const { access } = await services();
    const company = await seedCompany();
    await seedRootCeo(company.id);
    const [worker] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", permissions: { canCreateAgents: false } })
      .returning();
    await access.ensureMembership(company.id, "agent", worker!.id, "member", "active");
    await access.setPrincipalPermission(company.id, "agent", worker!.id, "tasks:assign", true, null);
    const app = await createApp(db, boardActor(company.id));

    const off = await request(app)
      .patch(`/api/agents/${worker!.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await access.setPrincipalPermission(company.id, "agent", worker!.id, "tasks:assign", true, null);
    expect(await grantKeys(company.id, "agent", worker!.id)).not.toContain("tasks:assign");

    const on = await request(app)
      .patch(`/api/agents/${worker!.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(await grantKeys(company.id, "agent", worker!.id)).toContain("tasks:assign");
  }, 60_000);
  it("never leaves a revoked permission granted when an automatic grant races the revoke", async () => {
    const { access } = await services();
    const company = await seedCompany();
    const adminId = await seedHumanMember(company.id, "admin");
    const membership = await memberId(company.id, "user", adminId);

    for (let round = 0; round < 10; round += 1) {
      // Start granted, with no revocation on record.
      await db.delete(principalPermissionRevocations);
      await access.setPrincipalPermission(company.id, "user", adminId, "users:invite", true, null, null, {
        decidedBy: { actorType: "user", actorId: BOARD_USER_ID },
      });
      const keep = (await grantKeys(company.id, "user", adminId))
        .filter((key) => key !== "users:invite")
        .map((permissionKey) => ({ permissionKey: permissionKey as PermissionKey, scope: null }));

      await Promise.all([
        access.setMemberPermissions(company.id, membership, keep, BOARD_USER_ID, { actorType: "user", actorId: BOARD_USER_ID }),
        access.setPrincipalPermission(company.id, "user", adminId, "users:invite", true, null),
      ]);

      expect(await grantKeys(company.id, "user", adminId)).not.toContain("users:invite");
    }
  }, 60_000);
});
