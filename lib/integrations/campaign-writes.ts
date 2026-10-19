import { z } from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  apiCampaignCreateSchema,
  apiCampaignUpdateSchema,
  buildCampaignCreateData,
  normalizeCampaignUpdate,
} from "@/lib/campaigns/input";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import {
  describeKeywordOverlaps,
  findKeywordConflicts,
  loadCampaignTriggers,
  type CampaignTrigger,
  type KeywordOverlap,
} from "@/lib/campaigns/keyword-conflicts";
import { generateReportShareSlug } from "@/lib/reports/share";
import { requireScope, type ServiceContext } from "./auth";
import { readCampaign } from "./campaigns";
import { ApiError } from "./http";

// Writes through a service key. Campaigns are always created paused, and only
// a key with campaigns:activate can switch one on or change one that is live,
// so the person who activates a campaign in the panel is the one approving it.

type CampaignDetail = Awaited<ReturnType<typeof readCampaign>>;
export type CampaignWriteResult = {
  campaign: CampaignDetail;
  keywordOverlaps: KeywordOverlap[];
};

// Fields that decide which comments a campaign answers.
const TRIGGER_FIELDS = [
  "keywords",
  "matchAnyWord",
  "wholeWordMatch",
  "matchAnyPost",
  "pendingNextReel",
  "postId",
] as const;

const ACTIVE_CAMPAIGN_ERROR = () =>
  new ApiError(
    "Campaign is active; deactivate it in the panel before editing it through the API",
    409
  );

function invalid(error: z.ZodError) {
  return new ApiError("Invalid input", 400, { details: z.flattenError(error) });
}

/**
 * One writer at a time per workspace, so two saves cannot both take a keyword.
 * The wait is bounded: a waiting save holds one of the few pooled connections
 * the webhook and link redirects also need.
 */
async function lockWorkspaceKeywords(
  tx: Prisma.TransactionClient,
  workspaceId: string
) {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`);
  try {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`openreply:campaign-keywords:${workspaceId}`}))`;
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new ApiError("Another campaign save is in progress; retry in a few seconds", 503);
    }
    throw error;
  }
}

const LOCK_WAIT = "3s";

/** Postgres lock_not_available (55P03), however the driver adapter wraps it. */
function isLockTimeout(error: unknown) {
  const text = `${(error as { meta?: { code?: string } })?.meta?.code ?? ""} ${(error as Error)?.message ?? ""}`;
  return text.includes("55P03") || text.includes("lock timeout");
}

function refuseConflicts(candidate: CampaignTrigger, others: CampaignTrigger[]) {
  const conflicts = findKeywordConflicts(candidate, others);
  if (conflicts.length > 0) {
    throw new ApiError("Keyword already used by another any-post campaign", 409, {
      conflicts,
    });
  }
}

async function resolveInstagramAccount(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  requestedId: string | null | undefined
) {
  if (requestedId && requestedId !== "all") {
    const account = await tx.instagramAccount.findFirst({
      where: { id: requestedId, workspaceId },
      select: { id: true },
    });
    if (!account) throw new ApiError("Instagram account not found", 404);
    return account.id;
  }
  const account = await tx.instagramAccount.findFirst({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true },
  });
  if (!account) {
    throw new ApiError("Connect Instagram before creating campaigns", 400);
  }
  return account.id;
}

export async function createCampaign(
  context: ServiceContext,
  body: unknown
): Promise<CampaignWriteResult> {
  requireScope(context, "campaigns:write");
  const parsed = apiCampaignCreateSchema.safeParse(body);
  if (!parsed.success) throw invalid(parsed.error);
  const { workspaceId } = context;

  const { id, keywordOverlaps } = await prisma.$transaction(async (tx) => {
    await lockWorkspaceKeywords(tx, workspaceId);
    const instagramAccountId = await resolveInstagramAccount(
      tx,
      workspaceId,
      parsed.data.instagramAccountId
    );
    const data = buildCampaignCreateData(parsed.data);
    const others = await loadCampaignTriggers(tx, workspaceId, instagramAccountId);
    refuseConflicts(
      { id: "", createdAt: new Date(), ...data, postId: data.postId ?? null },
      others
    );

    const links = buildInitialCampaignLinks({
      workspaceId,
      primaryUrl: parsed.data.trackedDestinationUrl,
      secondaryUrl: parsed.data.secondaryDestinationUrl,
      secondaryLabel: parsed.data.secondaryButtonLabel,
    });
    const created = await tx.automation.create({
      data: {
        ...data,
        isActive: false,
        workspaceId,
        instagramAccountId,
        reportShareSlug: generateReportShareSlug(),
        createdByServiceKeyId: context.keyId,
        ...(links.length > 0 ? { trackedLinks: { create: links } } : {}),
      },
      select: { id: true, createdAt: true },
    });
    return {
      id: created.id,
      keywordOverlaps: describeKeywordOverlaps(
        { ...data, ...created, isActive: false, postId: data.postId ?? null },
        others
      ),
    };
  });

  return { campaign: await readCampaign(workspaceId, id), keywordOverlaps };
}

export async function updateCampaign(
  context: ServiceContext,
  id: string,
  body: unknown
): Promise<CampaignWriteResult> {
  requireScope(context, "campaigns:write");
  const parsed = apiCampaignUpdateSchema.safeParse(body);
  if (!parsed.success) throw invalid(parsed.error);
  if (parsed.data.isActive !== undefined) {
    requireScope(context, "campaigns:activate");
  }
  const canActivate = context.scopes.includes("campaigns:activate");
  const { workspaceId } = context;
  const { automationData, links } = normalizeCampaignUpdate(parsed.data);

  const keywordOverlaps = await prisma.$transaction(async (tx) => {
    await lockWorkspaceKeywords(tx, workspaceId);
    const existing = await tx.automation.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true,
        matchAnyPost: true,
        pendingNextReel: true,
        postId: true,
        matchAnyWord: true,
        wholeWordMatch: true,
        keywords: true,
        instagramAccountId: true,
      },
    });
    if (!existing) throw new ApiError("Campaign not found", 404);
    if (existing.isActive && !canActivate) throw ACTIVE_CAMPAIGN_ERROR();

    // The buttons of DMs already delivered keep pointing at these links, so
    // moving them changes what people are sent to without anyone approving it.
    const movesLinks =
      (links.primaryUrl !== undefined && links.primaryUrl !== null) ||
      (links.secondaryUrl !== undefined && links.secondaryUrl !== null);
    if (movesLinks && !canActivate) {
      const delivered = await tx.dmLog.count({ where: { automationId: id, workspaceId } });
      if (delivered > 0) {
        throw new ApiError(
          "Campaign has already sent DMs; changing its links needs campaigns:activate or the panel",
          409
        );
      }
    }

    const { instagramAccountId, ...current } = existing;
    const merged: CampaignTrigger = {
      ...current,
      ...Object.fromEntries(
        Object.entries(automationData).filter(([key]) =>
          [...TRIGGER_FIELDS, "name", "isActive"].includes(key)
        )
      ),
    };
    if (!merged.matchAnyPost && !merged.pendingNextReel && !merged.postId) {
      throw new ApiError("Invalid input", 400, {
        details: { fieldErrors: { postId: ["Choose which post(s) trigger the campaign"] } },
      });
    }
    if (!merged.matchAnyWord && merged.keywords.length === 0) {
      throw new ApiError("Invalid input", 400, {
        details: { fieldErrors: { keywords: ["Add at least one keyword, or match any word"] } },
      });
    }

    const others = await loadCampaignTriggers(tx, workspaceId, instagramAccountId, id);
    // An edit that leaves the trigger alone is not blocked by a conflict the
    // campaign already had.
    if (TRIGGER_FIELDS.some((field) => automationData[field] !== undefined)) {
      refuseConflicts(merged, others);
    }

    // Re-checked by the write itself: a panel activation that commits while
    // this save waits on the row lock makes the condition fail here.
    const { count } = await tx.automation.updateMany({
      where: { id, workspaceId, ...(canActivate ? {} : { isActive: false }) },
      data: { ...automationData, lastEditedByServiceKeyId: context.keyId },
    });
    if (count === 0) throw ACTIVE_CAMPAIGN_ERROR();
    await syncCampaignLinks(tx, { workspaceId, automationId: id, ...links });
    return describeKeywordOverlaps(merged, others);
  });

  return { campaign: await readCampaign(workspaceId, id), keywordOverlaps };
}
