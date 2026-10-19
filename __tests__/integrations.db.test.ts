import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
import { getCampaign, listCampaigns } from "../lib/integrations/campaigns";
import { hashServiceToken, newServiceToken } from "../lib/integrations/auth";
import { callTool } from "../lib/integrations/mcp";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `integrations_${randomBytes(4).toString("hex")}`;
let sql: Client;
const context = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read"] };

describe.skipIf(!databaseUrl)("read-only integrations on real PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    const KEY_MIGRATION = "20261003120000_workspace_service_keys";
    const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort((a, b) => a.localeCompare(b));
    const apply = async (names: string[]) => {
      for (const name of names) await sql.query(readFileSync(path.join(root, name, "migration.sql"), "utf8"));
    };
    await apply(dirs.filter(name => name < KEY_MIGRATION));
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "integration@example.test" } });
    for (const id of ["workspace", "other"]) {
      await state.db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
      await state.db.instagramAccount.create({ data: { id: `account_${id}`, workspaceId: id, instagramId: id, username: id, accessToken: "local-only-secret" } });
    }
    // Raw SQL: the generated client already knows columns that later migrations add.
    await sql.query(`INSERT INTO "Automation" ("id", "workspaceId", "instagramAccountId", "name", "keywords", "dmMessage", "isActive",
      "openingDmEnabled", "openingDmMessage", "openingDmButtonLabel", "reportShareSlug", "updatedAt") VALUES
      ('campaign', 'workspace', 'account_workspace', 'Example', ARRAY['LINK'], 'Your link', true, true, 'Tap below', 'Open', 'private-report', now()),
      ('foreign', 'other', 'account_other', 'Other', ARRAY[]::text[], 'Private', false, false, NULL, NULL, NULL, now())`);
    const snapshot = async () => (await sql.query(`SELECT * FROM "Automation" ORDER BY "id"`)).rows;
    const before = await snapshot();
    await apply([KEY_MIGRATION]);
    expect(await snapshot()).toEqual(before);
    await apply(dirs.filter(name => name > KEY_MIGRATION));
    const date = new Date("2026-01-01");
    for (const [id, label, workspaceId] of [["b", "Second", "workspace"], ["a", "First", "workspace"], ["foreign-link", "Hidden", "other"]]) {
      await state.db.trackedLink.create({ data: { id, label, workspaceId, automationId: "campaign", slug: id, destinationUrl: `https://example.test/${id}`, position: 0, createdAt: date } });
    }
  }, 60_000);
  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("returns ordered complete details with a safe whitelist and no writes", async () => {
    const before = await state.db.automation.findUniqueOrThrow({ where: { id: "campaign" } });
    const detail = await getCampaign(context, "campaign");
    expect(detail.openingDmEnabled).toBe(true);
    expect(detail.openingDmMessage).toBe("Tap below");
    expect(detail.trackedDestinationUrl).toBe("https://example.test/a");
    expect(detail.secondaryDestinationUrl).toBe("https://example.test/b");
    expect(detail.secondaryButtonLabel).toBe("Second");
    expect(detail.trackedLinks).toEqual([
      { destinationUrl: "https://example.test/a", label: "First", position: 0 },
      { destinationUrl: "https://example.test/b", label: "Second", position: 0 },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/private-report|local-only-secret|foreign-link/);
    expect(detail).not.toHaveProperty("reportShareSlug");
    expect(detail).not.toHaveProperty("instagramAccount");
    expect(await callTool(context, "get_campaign", { id: "campaign" })).toEqual(detail);
    expect(await state.db.automation.findUniqueOrThrow({ where: { id: "campaign" } })).toEqual(before);
  });
  it("isolates workspaces and scope and keeps lists compact", async () => {
    await expect(getCampaign(context, "foreign")).rejects.toMatchObject({ status: 404 });
    await expect(getCampaign({ ...context, scopes: [] }, "campaign")).rejects.toMatchObject({ status: 403 });
    const summaries = await listCampaigns(context);
    expect(summaries.map(c => c.id)).toEqual(["campaign"]);
    expect(summaries[0]).not.toHaveProperty("trackedLinks");
    expect(summaries[0]).not.toHaveProperty("openingDmMessage");
  });
  it("follows position changes and returns null for absent links", async () => {
    await state.db.trackedLink.update({ where: { id: "b" }, data: { position: -1 } });
    expect((await getCampaign(context, "campaign")).trackedDestinationUrl).toBe("https://example.test/b");
    expect(await getCampaign({ ...context, workspaceId: "other" }, "foreign")).toMatchObject({ trackedLinks: [], trackedDestinationUrl: null, secondaryDestinationUrl: null });
  });
  it("stores only hashed keys with fixed independent expiry and workspace cascade", async () => {
    const oldExpiry = new Date("2099-01-01");
    await state.db.serviceKey.create({ data: { id: "old", workspaceId: "workspace", name: "Old", tokenHash: hashServiceToken(newServiceToken()), scopes: ["campaigns:read"], expiresAt: oldExpiry } });
    for (const days of [30, 60, 90]) {
      const token = newServiceToken();
      const expiresAt = new Date(Date.now() + days * 86400000);
      const saved = await state.db.serviceKey.create({ data: { workspaceId: "other", name: `${days} days`, tokenHash: hashServiceToken(token), scopes: ["campaigns:read"], expiresAt } });
      expect(saved.expiresAt).toEqual(expiresAt);
      expect(JSON.stringify(saved)).not.toContain(token);
    }
    expect((await state.db.serviceKey.findUniqueOrThrow({ where: { id: "old" } })).expiresAt).toEqual(oldExpiry);
    await state.db.workspace.delete({ where: { id: "other" } });
    expect(await state.db.serviceKey.count({ where: { workspaceId: "other" } })).toBe(0);
    expect(await state.db.serviceKey.count({ where: { workspaceId: "workspace" } })).toBe(1);
  });
});
