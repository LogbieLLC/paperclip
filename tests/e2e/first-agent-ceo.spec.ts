import { expect, request as pwRequest, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { mockOnboardingLocalAiConnection } from "./helpers/onboarding-ai-connection";

/**
 * E2E: a company's first agent is its CEO (paperclipai/paperclip#11440).
 *
 * The onboarding wizard used to file its first agent under the `general` role,
 * so a new company had no CEO. Agent join approval needs a CEO for the new
 * agent to report to, so an external runtime such as OpenClaw could never be
 * approved into the company it was meant to lead.
 *
 * This spec drives both ways a company gets its first agent:
 *  - the onboarding wizard, with a customer-chosen name that says nothing
 *    about leadership; and
 *  - an external agent joining a brand-new company by invite. That agent then
 *    acts as CEO: it approves the next agent's join request on the board's
 *    behalf, while board approvals stay board-only. (Human join requests are
 *    refused to agents too; the route tests cover that, because in this
 *    single-user local mode the board's own human join approves itself.)
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

type AgentRow = { id: string; name: string; role: string; reportsTo: string | null; status: string };

async function expectOk(response: APIResponse, label: string) {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
}

async function companyByName(request: APIRequestContext, name: string) {
  const response = await request.get("/api/companies");
  await expectOk(response, "list companies");
  const companies = (await response.json()) as Array<{ id: string; name: string }>;
  const company = companies.find((candidate) => candidate.name === name);
  expect(company, `company ${name}`).toBeTruthy();
  return company!;
}

async function listAgents(request: APIRequestContext, companyId: string) {
  const response = await request.get(`/api/companies/${companyId}/agents`);
  await expectOk(response, "list agents");
  return (await response.json()) as AgentRow[];
}

/** Run the real hire, but on an inert adapter so no agent process spawns. */
async function forwardHireToInertAdapter(page: Page, hireBodies: Array<Record<string, unknown>>) {
  await mockOnboardingLocalAiConnection(page);
  await page.route("**/test-environment", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "pass", checks: [] }) }),
  );
  await page.route("**/agent-hires", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() || "{}") as Record<string, unknown>;
    hireBodies.push(body);
    const auth = req.headers().authorization;
    const real = await fetch(new URL(req.url(), BASE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({
        name: body.name,
        role: body.role,
        onboardingFirstAgent: body.onboardingFirstAgent,
        adapterType: "http",
        adapterConfig: { url: "http://127.0.0.1:1/dead" },
        runtimeConfig: { heartbeat: { enabled: false } },
      }),
    });
    await route.fulfill({ status: real.status, contentType: "application/json", body: await real.text() });
  });
}

async function createAgentJoinRequest(board: APIRequestContext, companyId: string, agentName: string) {
  const inviteResponse = await board.post(`/api/companies/${companyId}/invites`, {
    data: { allowedJoinTypes: "agent" },
  });
  await expectOk(inviteResponse, `create invite for ${agentName}`);
  const invite = (await inviteResponse.json()) as { token: string };

  const acceptResponse = await board.post(`/api/invites/${invite.token}/accept`, {
    data: {
      requestType: "agent",
      agentName,
      adapterType: "process",
      capabilities: `${agentName} joins by invite during e2e coverage.`,
    },
  });
  await expectOk(acceptResponse, `accept invite for ${agentName}`);
  return (await acceptResponse.json()) as { id: string; claimSecret: string };
}

test.describe("First agent is the company CEO", () => {
  test("the onboarding wizard hires its first agent as CEO whatever it is named", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const hireBodies: Array<Record<string, unknown>> = [];
    await forwardHireToInertAdapter(page, hireBodies);

    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    const companyName = `E2E-First-CEO-${Date.now()}`;
    await page.goto("/onboarding");
    const startBtn = page.getByRole("button", { name: /Start Onboarding|New Organization|Add Agent/ });
    if (await startBtn.count()) await startBtn.first().click();
    const createCard = page.getByRole("button", { name: /Build a new organization/ });
    if (await createCard.count()) await createCard.first().click();

    await expect(
      page.getByRole("heading", { name: "What is the name of your organization?" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("e.g. Northwind Labs").fill(companyName);
    await page.getByRole("button", { name: /^Continue/ }).click();

    // A name that says nothing about leading the company.
    await page.waitForSelector("#onboarding-agent-name", { timeout: 30_000 });
    await page.locator("#onboarding-agent-name").fill("Ada");
    await page.getByRole("button", { name: /^Next$/ }).click();

    const source = page.getByRole("radio").first();
    await source.waitFor({ timeout: 30_000 });
    await source.click();
    const connect = page.getByRole("button", { name: /^Connect$/ });
    await expect(connect).toBeEnabled({ timeout: 30_000 });
    await connect.click();

    // The review step appears once the hire succeeded.
    await expect(page.getByRole("button", { name: /Get started/ })).toBeVisible({ timeout: 20_000 });

    expect(hireBodies).toHaveLength(1);
    expect(hireBodies[0]!.role).toBe("ceo");

    const company = await companyByName(page.request, companyName);
    const agents = await listAgents(page.request, company.id);
    const ada = agents.find((agent) => agent.name === "Ada");
    expect(ada, JSON.stringify(agents)).toBeTruthy();
    expect(ada!.role).toBe("ceo");
    expect(ada!.reportsTo).toBeNull();

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });

  test("an external agent founds a new company as CEO and approves agent joins, but not board approvals", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      const companyResponse = await board.post("/api/companies", {
        data: { name: `E2E OpenClaw Founder ${Date.now()}` },
      });
      await expectOk(companyResponse, "create company");
      const company = (await companyResponse.json()) as { id: string };
      expect(await listAgents(board, company.id)).toHaveLength(0);

      // The reported deadlock: the first agent join into a company with no
      // CEO used to fail with "this company has no active CEO".
      const founderRequest = await createAgentJoinRequest(board, company.id, "OpenClaw");
      const approveFounder = await board.post(
        `/api/companies/${company.id}/join-requests/${founderRequest.id}/approve`,
      );
      await expectOk(approveFounder, "board approves the founding agent");
      const { createdAgentId: ceoId } = (await approveFounder.json()) as { createdAgentId: string };

      const [ceo] = await listAgents(board, company.id);
      expect(ceo).toMatchObject({ id: ceoId, name: "OpenClaw", role: "ceo", reportsTo: null });

      // The founder claims its API key the way an external runtime does after
      // approval, then acts for the board on agent joins.
      const claimResponse = await board.post(`/api/join-requests/${founderRequest.id}/claim-api-key`, {
        data: { claimSecret: founderRequest.claimSecret },
      });
      await expectOk(claimResponse, "CEO claims its API key");
      const { token: ceoKey } = (await claimResponse.json()) as { token: string };
      const ceoApi = await pwRequest.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${ceoKey}` },
      });
      try {
        const workerRequest = await createAgentJoinRequest(board, company.id, "Researcher");

        const pendingResponse = await ceoApi.get(
          `/api/companies/${company.id}/join-requests?status=pending_approval`,
        );
        await expectOk(pendingResponse, "CEO lists pending join requests");
        const pending = (await pendingResponse.json()) as Array<{ id: string; requestType: string }>;
        expect(pending.map((row) => row.id)).toContain(workerRequest.id);
        expect(pending.every((row) => row.requestType === "agent")).toBe(true);

        const approveWorker = await ceoApi.post(
          `/api/companies/${company.id}/join-requests/${workerRequest.id}/approve`,
        );
        await expectOk(approveWorker, "CEO approves the researcher");
        const { createdAgentId: workerId } = (await approveWorker.json()) as { createdAgentId: string };
        const worker = (await listAgents(board, company.id)).find((agent) => agent.id === workerId);
        expect(worker).toMatchObject({ name: "Researcher", role: "general", reportsTo: ceoId });
        const workerClaim = await board.post(`/api/join-requests/${workerRequest.id}/claim-api-key`, {
          data: { claimSecret: workerRequest.claimSecret },
        });
        await expectOk(workerClaim, "CEO-approved researcher claims its API key");
        expect(((await workerClaim.json()) as { agentId: string }).agentId).toBe(workerId);

        // Board approvals stay with the board: the CEO can ask for one but
        // cannot grant its own request.
        const askBoard = await ceoApi.post(`/api/companies/${company.id}/approvals`, {
          data: {
            type: "request_board_approval",
            payload: { title: "Budget increase", summary: "Raise the research budget." },
          },
        });
        await expectOk(askBoard, "CEO requests a board decision");
        const boardRequest = (await askBoard.json()) as { id: string; status: string };
        expect(boardRequest.status).toBe("pending");
        const selfApprove = await ceoApi.post(`/api/approvals/${boardRequest.id}/approve`, { data: {} });
        expect(selfApprove.status()).toBe(403);
      } finally {
        await ceoApi.dispose();
      }
    } finally {
      await board.dispose();
    }
  });
});
