import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  context: vi.fn(),
  media: vi.fn(),
  key: { findUnique: vi.fn(), update: vi.fn() },
  eval: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: { serviceKey: state.key } }));
vi.mock("@/lib/instagram-accounts", () => ({ getWorkspaceInstagramAccount: state.account }));
vi.mock("@/lib/instagram/provider", () => ({ createInstagramContext: state.context, getUserMedia: state.media }));
vi.mock("ioredis", () => ({ default: class { status = "ready"; eval = state.eval; listenerCount() { return 1; } } }));

import { listPosts } from "../lib/integrations/posts";
import { GET } from "../app/api/v1/posts/route";

const token = `orp_${"a".repeat(43)}`;
const context = { workspaceId: "workspace", keyId: "key", scopes: ["campaigns:read"] };
const get = (query = "") =>
  GET(new Request(`https://example.test/api/v1/posts${query}`, { headers: { authorization: `Bearer ${token}` } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  state.key.findUnique.mockResolvedValue({ id: "key", workspaceId: "workspace", scopes: ["campaigns:read"], expiresAt: new Date("2099-01-01"), revokedAt: null });
  state.key.update.mockResolvedValue({});
  state.eval.mockResolvedValue(1);
  state.account.mockResolvedValue({ id: "account", provider: "META", accessToken: "encrypted" });
  state.context.mockResolvedValue({ provider: "META", accessToken: "IGAA-secret" });
  state.media.mockResolvedValue([
    {
      id: "1789", caption: "New reel", permalink: "https://www.instagram.com/reel/abc/", timestamp: "2026-10-18T12:00:00+0000",
      media_type: "VIDEO", media_product_type: "REELS", media_url: "https://cdn.example/video.mp4", like_count: 9, comments_count: 2,
    },
  ]);
});

describe("listPosts", () => {
  it("returns only the fields needed to bind a campaign", async () => {
    expect(await listPosts(context, { limit: 25 })).toEqual([
      { id: "1789", caption: "New reel", permalink: "https://www.instagram.com/reel/abc/", timestamp: "2026-10-18T12:00:00+0000", media_type: "VIDEO", media_product_type: "REELS" },
    ]);
    expect(state.media).toHaveBeenCalledWith({ context: { provider: "META", accessToken: "IGAA-secret" }, limit: 25 });
    expect(state.account).toHaveBeenCalledWith("workspace", undefined);
  });

  it("fills absent fields with null", async () => {
    state.media.mockResolvedValue([{ id: "2" }]);
    expect(await listPosts(context, { limit: 1 })).toEqual([
      { id: "2", caption: null, permalink: null, timestamp: null, media_type: null, media_product_type: null },
    ]);
  });

  it("needs campaigns:read", async () => {
    await expect(listPosts({ ...context, scopes: ["campaigns:write"] }, { limit: 25 })).rejects.toMatchObject({ status: 403 });
  });

  it("asks to connect Instagram when there is no account", async () => {
    state.account.mockResolvedValue(null);
    await expect(listPosts(context, { limit: 25 })).rejects.toMatchObject({ status: 400, message: "Connect Instagram first" });
  });

  it("404s on an account that is not the workspace's", async () => {
    state.account.mockResolvedValue(null);
    await expect(listPosts(context, { limit: 25, instagramAccountId: "foreign" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("GET /api/v1/posts", () => {
  it("lists posts without caching", async () => {
    const response = await get("?limit=5");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).data[0].id).toBe("1789");
    expect(state.media).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it.each(["?limit=0", "?limit=51", "?limit=x", "?limit=2.5"])("rejects %s", async (query) => {
    expect((await get(query)).status).toBe(400);
  });

  it("hides the Instagram error, which can carry account details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.media.mockRejectedValue(new Error("Invalid OAuth access token IGAA-secret"));
    const response = await get();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not load posts from Instagram" });
    expect(text).not.toContain("IGAA-secret");
    log.mockRestore();
  });

  it("requires a Bearer key", async () => {
    expect((await GET(new Request("https://example.test/api/v1/posts"))).status).toBe(401);
  });
});
