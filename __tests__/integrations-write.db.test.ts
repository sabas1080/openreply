/**
 * Campaign writes through service keys, against a real Postgres (the keyword
 * lock and the audit columns only exist there). Skipped without
 * TEST_DATABASE_URL; see tracked-link-order.db.test.ts for how to run it.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
}));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: async () => "workspace" }));
vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => true,
  getCurrentWorkspaceContext: async () => ({ userId: "owner", workspaceId: "workspace", role: "OWNER" }),
}));

import { createCampaign, updateCampaign } from "../lib/integrations/campaign-writes";
import { GET as panelGet, PATCH as panelPatch } from "../app/api/automations/route";
import { duplicateCampaign } from "../lib/campaigns/duplicate";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `integrations_write_${randomBytes(4).toString("hex")}`;
let sql: Client;

const READ = "campaigns:read";
const WRITE = "campaigns:write";
const ACTIVATE = "campaigns:activate";
const writer = { workspaceId: "workspace", keyId: "key_hermes", scopes: [READ, WRITE] };
const owner = { workspaceId: "workspace", keyId: "key_owner", scopes: [READ, WRITE, ACTIVATE] };

const anyPost = (keyword: string, extra: Record<string, unknown> = {}) => ({
  name: `Any ${keyword}`,
  matchAnyPost: true,
  keywords: [keyword],
  dmMessage: "Here is the link",
  ...extra,
});

const status = (promise: Promise<unknown>) =>
  promise.then(() => 201, (error: { status?: number }) => error.status ?? 500);

describe.skipIf(!databaseUrl)("campaign writes on real PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "write@example.test" } });
    for (const id of ["workspace", "other"]) {
      await state.db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
      await state.db.instagramAccount.create({ data: { id: `account_${id}`, workspaceId: id, instagramId: id, username: id, accessToken: "local-only-secret" } });
    }
    for (const [id, name] of [["key_hermes", "Hermes"], ["key_owner", "Owner"]]) {
      await state.db.serviceKey.create({ data: { id, name, workspaceId: "workspace", tokenHash: id, scopes: [READ, WRITE], expiresAt: new Date("2099-01-01") } });
    }
  }, 60_000);

  beforeEach(async () => {
    await state.db.automation.deleteMany({});
  });

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); }
  });

  it("creates an any-post campaign with two buttons and public replies, paused and audited", async () => {
    const { campaign } = await createCampaign(writer, anyPost("HUNTER", {
      linkButtonLabel: "Shop",
      trackedDestinationUrl: "https://example.test/shop",
      secondaryDestinationUrl: "https://example.test/docs",
      secondaryButtonLabel: "Docs",
      publicReplyEnabled: true,
      publicReplyMessages: ["Check your DMs", "Sent!"],
    }));
    expect(campaign.isActive).toBe(false);
    expect(campaign.trackedDestinationUrl).toBe("https://example.test/shop");
    expect(campaign.secondaryDestinationUrl).toBe("https://example.test/docs");
    expect(campaign.secondaryButtonLabel).toBe("Docs");
    expect(campaign.publicReplyMessages).toEqual(["Check your DMs", "Sent!"]);
    expect(campaign.createdByServiceKey).toEqual({ name: "Hermes" });
    expect(campaign.instagramAccountId).toBe("account_workspace");
  });

  it("creates a next-reel campaign without a post", async () => {
    const { campaign } = await createCampaign(writer, { name: "Reel", pendingNextReel: true, postId: "123", keywords: ["REEL"], dmMessage: "Hi" });
    expect(campaign).toMatchObject({ pendingNextReel: true, postId: null, matchAnyPost: false });
  });

  it("creates a specific-post campaign bound to the post", async () => {
    const { campaign } = await createCampaign(writer, { name: "Post", postId: "1789", postUrl: "https://www.instagram.com/reel/abc/", keywords: ["POST"], dmMessage: "Hi" });
    expect(campaign).toMatchObject({ postId: "1789", postUrl: "https://www.instagram.com/reel/abc/", matchAnyPost: false });
  });

  it("refuses isActive on create", async () => {
    await expect(createCampaign(owner, anyPost("X", { isActive: true }))).rejects.toMatchObject({ status: 400 });
  });

  it("needs campaigns:write", async () => {
    await expect(createCampaign({ ...writer, scopes: [READ] }, anyPost("X"))).rejects.toMatchObject({ status: 403, message: "Missing scope: campaigns:write" });
  });

  it("creates with a write-only key and still returns the campaign", async () => {
    const { campaign } = await createCampaign({ ...writer, scopes: [WRITE] }, anyPost("WRITEONLY"));
    expect(campaign.name).toBe("Any WRITEONLY");
  });

  it("refuses another workspace's Instagram account", async () => {
    await expect(createCampaign(writer, anyPost("X", { instagramAccountId: "account_other" }))).rejects.toMatchObject({ status: 404 });
  });

  it("a write key cannot switch a campaign on; an activate key can", async () => {
    const { campaign } = await createCampaign(writer, anyPost("ON"));
    await expect(updateCampaign(writer, campaign.id, { isActive: true })).rejects.toMatchObject({ status: 403, message: "Missing scope: campaigns:activate" });
    const { campaign: on } = await updateCampaign({ ...owner, scopes: [READ, WRITE, ACTIVATE] }, campaign.id, { isActive: true });
    expect(on.isActive).toBe(true);
  });

  it("a write key loses to an activation that lands while it is saving", async () => {
    const { campaign } = await createCampaign(writer, anyPost("RACEON"));
    // The panel switches the campaign on in a transaction that is still open.
    const panel = new Client({ connectionString: databaseUrl });
    await panel.connect();
    await panel.query(`SET search_path TO "${schema}"`);
    await panel.query("BEGIN");
    await panel.query(`UPDATE "Automation" SET "isActive" = true WHERE id = $1`, [campaign.id]);
    const edit = updateCampaign(writer, campaign.id, { dmMessage: "Edited while it went live" }).then(
      () => 200, (error: { status?: number }) => error.status ?? 500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await panel.query("COMMIT");
    await panel.end();
    expect(await edit).toBe(409);
    const row = await state.db.automation.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.dmMessage).toBe("Here is the link");
  });

  it("a write key cannot edit an active campaign; an activate key can", async () => {
    const { campaign } = await createCampaign(writer, anyPost("LIVE"));
    await state.db.automation.update({ where: { id: campaign.id }, data: { isActive: true } });
    await expect(updateCampaign(writer, campaign.id, { dmMessage: "Changed" })).rejects.toMatchObject({ status: 409 });
    const { campaign: edited } = await updateCampaign(owner, campaign.id, { dmMessage: "Changed" });
    expect(edited.dmMessage).toBe("Changed");
    expect(edited.lastEditedByServiceKey).toEqual({ name: "Owner" });
  });

  it("a write key cannot repoint links already sent in DMs; an activate key can", async () => {
    const { campaign } = await createCampaign(writer, anyPost("SENT", { trackedDestinationUrl: "https://example.test/old" }));
    await state.db.dmLog.create({ data: {
      workspaceId: "workspace", automationId: campaign.id, instagramAccountId: "account_workspace",
      commenterId: "c1", commentText: "sent", commentId: "comment_1", status: "SENT",
    } });
    await expect(updateCampaign(writer, campaign.id, { trackedDestinationUrl: "https://example.test/new" })).rejects.toMatchObject({ status: 409 });
    await expect(updateCampaign(writer, campaign.id, { secondaryDestinationUrl: "https://example.test/2" })).rejects.toMatchObject({ status: 409 });
    const { campaign: text } = await updateCampaign(writer, campaign.id, { dmMessage: "Future DMs only" });
    expect(text.trackedDestinationUrl).toBe("https://example.test/old");
    const { campaign: moved } = await updateCampaign(owner, campaign.id, { trackedDestinationUrl: "https://example.test/new" });
    expect(moved.trackedDestinationUrl).toBe("https://example.test/new");
  });

  it("refuses an any-post keyword another any-post campaign uses, paused or not", async () => {
    const { campaign: first } = await createCampaign(writer, anyPost("HUNTER"));
    const error = await createCampaign(writer, anyPost("hunter")).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.extra.conflicts).toEqual([{ keyword: "hunter", campaign: { id: first.id, name: "Any HUNTER", isActive: false } }]);
  });

  it("refuses an update that moves the keywords into a conflict", async () => {
    await createCampaign(writer, anyPost("BOMBER"));
    const { campaign } = await createCampaign(writer, anyPost("CAT"));
    await expect(updateCampaign(writer, campaign.id, { keywords: ["bomber"] })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an update that leaves the campaign without a trigger", async () => {
    const { campaign } = await createCampaign(writer, anyPost("ALONE"));
    await expect(updateCampaign(writer, campaign.id, { matchAnyPost: false })).rejects.toMatchObject({ status: 400 });
  });

  it("lets only one of two simultaneous creates take a keyword", async () => {
    // Several rounds: a single pair can serialise by chance and hide a race.
    for (let round = 0; round < 8; round++) {
      const results = await Promise.all([
        status(createCampaign(writer, anyPost(`RACE${round}`))),
        status(createCampaign(writer, anyPost(`race${round}`))),
      ]);
      expect(results.sort(), `round ${round}`).toEqual([201, 409]);
    }
  });

  it("answers 503 instead of hanging when another save holds the keyword lock", async () => {
    const other = new Client({ connectionString: databaseUrl });
    await other.connect();
    await other.query("SELECT pg_advisory_lock(hashtext('openreply:campaign-keywords:workspace'))");
    try {
      const started = Date.now();
      const error = await createCampaign(writer, anyPost("LOCKED")).catch((e) => e);
      expect(error.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      await other.end();
    }
    expect((await createCampaign(writer, anyPost("LOCKED"))).campaign.name).toBe("Any LOCKED");
  }, 15_000);

  it("reports which campaign's DM goes out when a post campaign shares a keyword", async () => {
    const { campaign: older } = await createCampaign(writer, anyPost("SHARED"));
    const { keywordOverlaps } = await createCampaign(writer, { name: "Reel campaign", postId: "55", keywords: ["shared"], dmMessage: "Hi" });
    expect(keywordOverlaps).toHaveLength(1);
    expect(keywordOverlaps[0].winner).toEqual({ id: older.id, name: "Any SHARED" });
  });

  it("returns no secrets", async () => {
    const result = await createCampaign(writer, anyPost("SAFE", { trackedDestinationUrl: "https://example.test/safe" }));
    expect(JSON.stringify(result)).not.toMatch(/local-only-secret|reportShareSlug|tokenHash|slug|accessToken/);
  });

  it("404s on another workspace's campaign", async () => {
    const { campaign } = await createCampaign(writer, anyPost("MINE"));
    await expect(updateCampaign({ ...writer, workspaceId: "other" }, campaign.id, { name: "Stolen" })).rejects.toMatchObject({ status: 404 });
  });

  it("a panel edit clears the API editor", async () => {
    const { campaign } = await createCampaign(writer, anyPost("PANEL"));
    await updateCampaign(writer, campaign.id, { name: "By Hermes" });
    const res = await panelPatch(new NextRequest(`http://localhost/api/automations?id=${campaign.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "By Sabas" }),
    }));
    expect(res.status).toBe(200);
    const row = await state.db.automation.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.lastEditedByServiceKeyId).toBeNull();
    expect(row.createdByServiceKeyId).toBe("key_hermes");
  });

  it("switching a campaign on in the panel keeps the API editor visible", async () => {
    const { campaign } = await createCampaign(writer, anyPost("TOGGLE"));
    await updateCampaign(writer, campaign.id, { dmMessage: "Edited by Hermes" });
    const listed = await (await panelGet(new NextRequest("http://localhost/api/automations"))).json();
    expect(listed.data.find((c: { id: string }) => c.id === campaign.id).lastEditedByServiceKey).toEqual({ name: "Hermes" });
    const res = await panelPatch(new NextRequest(`http://localhost/api/automations?id=${campaign.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: true }),
    }));
    expect(res.status).toBe(200);
    const row = await state.db.automation.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.isActive).toBe(true);
    expect(row.lastEditedByServiceKeyId).toBe("key_hermes");
  });

  it("a panel duplicate is not attributed to the API key", async () => {
    const { campaign } = await createCampaign(writer, anyPost("DUP"));
    await updateCampaign(writer, campaign.id, { name: "Edited" });
    const copy = await duplicateCampaign({ automationId: campaign.id, workspaceId: "workspace" });
    expect(copy).not.toBeNull();
    const row = await state.db.automation.findUniqueOrThrow({ where: { id: copy!.id } });
    expect(row.createdByServiceKeyId).toBeNull();
    expect(row.lastEditedByServiceKeyId).toBeNull();
  });
});
