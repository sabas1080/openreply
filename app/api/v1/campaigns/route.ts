import { z } from "zod";
import { authenticateService } from "@/lib/integrations/auth";
import { getCampaign, getCampaignStats, listCampaigns } from "@/lib/integrations/campaigns";
import { createCampaign, updateCampaign, type CampaignWriteResult } from "@/lib/integrations/campaign-writes";
import { apiError, ApiError, checkOrigin, readJson } from "@/lib/integrations/http";

const idSchema = z.string().min(1).max(100);
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id !== null && !idSchema.safeParse(id).success) throw new ApiError("Invalid campaign id");
    if (url.searchParams.has("stats") && !id) throw new ApiError("Campaign id required for stats");
    const data = id ? url.searchParams.has("stats") ? await getCampaignStats(context, id) : await getCampaign(context, id) : await listCampaigns(context);
    return Response.json({ data }, { headers: noStore });
  } catch (error) { return apiError(error); }
}

const written = ({ campaign, keywordOverlaps }: CampaignWriteResult, status: number) =>
  Response.json({ data: campaign, keywordOverlaps }, { status, headers: noStore });

/** Create a campaign. It is always created paused. Needs campaigns:write. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    return written(await createCampaign(context, await readJson(request)), 201);
  } catch (error) { return apiError(error); }
}

/** Update `?id=`. isActive, or any change to an active campaign, needs campaigns:activate. */
export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const context = await authenticateService(request);
    const id = new URL(request.url).searchParams.get("id");
    if (id === null) throw new ApiError("Campaign id required");
    if (!idSchema.safeParse(id).success) throw new ApiError("Invalid campaign id");
    return written(await updateCampaign(context, id, await readJson(request)), 200);
  } catch (error) { return apiError(error); }
}
