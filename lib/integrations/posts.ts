import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";
import { requireScope, type ServiceContext } from "./auth";
import { ApiError } from "./http";

export type PostSummary = {
  id: string;
  caption: string | null;
  permalink: string | null;
  timestamp: string | null;
  media_type: string | null;
  media_product_type: string | null;
};

/**
 * Recent posts and reels of a connected account, so a client can bind a
 * campaign to one by postId. Errors from Instagram are logged, never returned:
 * they can carry account details.
 */
export async function listPosts(
  context: ServiceContext,
  { limit, instagramAccountId }: { limit: number; instagramAccountId?: string }
): Promise<PostSummary[]> {
  requireScope(context, "campaigns:read");
  const account = await getWorkspaceInstagramAccount(context.workspaceId, instagramAccountId);
  if (!account) {
    throw instagramAccountId
      ? new ApiError("Instagram account not found", 404)
      : new ApiError("Connect Instagram first", 400);
  }

  let media;
  try {
    media = await getUserMedia({ context: await createInstagramContext(account), limit });
  } catch (error) {
    console.error("[Integrations] Instagram posts failed:", error);
    throw new ApiError("Could not load posts from Instagram", 502);
  }

  return media.map((post) => ({
    id: post.id,
    caption: post.caption ?? null,
    permalink: post.permalink ?? null,
    timestamp: post.timestamp ?? null,
    media_type: post.media_type ?? null,
    media_product_type: post.media_product_type ?? null,
  }));
}
