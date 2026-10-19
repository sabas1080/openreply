import { z } from "zod";
import { authenticateService } from "@/lib/integrations/auth";
import { apiError, ApiError, checkOrigin } from "@/lib/integrations/http";
import { listPosts } from "@/lib/integrations/posts";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  instagramAccountId: z.string().min(1).max(100).optional(),
});

/** Recent posts and reels (`?limit=` 1-50, default 25). Needs campaigns:read. */
export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const params = new URL(request.url).searchParams;
    const query = querySchema.safeParse({
      limit: params.get("limit") ?? undefined,
      instagramAccountId: params.get("instagramAccountId") ?? undefined,
    });
    if (!query.success) throw new ApiError("Invalid query");
    const data = await listPosts(context, query.data);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
