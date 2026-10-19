import type { Prisma } from "@/app/generated/prisma/client";
import { matchKeywords, normalizeKeyword } from "@/lib/utils/keyword-matcher";

// Meta allows one private reply per comment, and the DM worker tries matching
// campaigns oldest first (createdAt asc). So two campaigns that can fire on
// the same comment never both DM: the older one wins and the other is logged
// SKIPPED_DEDUP. These helpers say so before a campaign is saved.

export type CampaignTrigger = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  matchAnyPost: boolean;
  pendingNextReel: boolean;
  postId: string | null;
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  keywords: string[];
};

export type KeywordConflict = {
  keyword: string | null;
  campaign: { id: string; name: string; isActive: boolean };
};

export type KeywordOverlap = {
  keyword: string | null;
  campaigns: {
    id: string;
    name: string;
    isActive: boolean;
    createdAt: string;
    trigger: "any_post" | "next_reel" | "post";
  }[];
  winner: { id: string; name: string };
};

const TRIGGER_SELECT = {
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
} as const;

/**
 * Two keywords answer the same comments when they are equal, or when a
 * comment made of one would match the other ("hunter cat" contains the word
 * "hunter"; "catsniffer" contains a partial-match "cat").
 */
function keywordsOverlap(
  a: string,
  aWholeWord: boolean,
  b: string,
  bWholeWord: boolean
) {
  const normalA = normalizeKeyword(a);
  const normalB = normalizeKeyword(b);
  if (normalA === "" || normalB === "") return false;
  return (
    normalA === normalB ||
    matchKeywords(a, [b], bWholeWord).matched ||
    matchKeywords(b, [a], aWholeWord).matched
  );
}

/** Keyword of `candidate` that `other` also answers to; null for any-word. */
function sharedKeyword(
  candidate: CampaignTrigger,
  other: CampaignTrigger
): { shared: boolean; keyword: string | null } {
  if (candidate.matchAnyWord || other.matchAnyWord) {
    return { shared: true, keyword: null };
  }
  const keyword = candidate.keywords.find((mine) =>
    other.keywords.some((theirs) =>
      keywordsOverlap(mine, candidate.wholeWordMatch, theirs, other.wholeWordMatch)
    )
  );
  return keyword === undefined
    ? { shared: false, keyword: null }
    : { shared: true, keyword };
}

function canFireOnSameComment(a: CampaignTrigger, b: CampaignTrigger) {
  if (a.matchAnyPost || b.matchAnyPost) return true;
  // Both wait for the same next reel.
  if (a.pendingNextReel && b.pendingNextReel) return true;
  return Boolean(a.postId) && a.postId === b.postId;
}

function byWorkerOrder(a: CampaignTrigger, b: CampaignTrigger) {
  const time = a.createdAt.getTime() - b.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const triggerOf = (c: CampaignTrigger) =>
  c.matchAnyPost ? "any_post" : c.pendingNextReel ? "next_reel" : "post";

/**
 * Any-post campaigns that already answer to one of the candidate's keywords,
 * paused or not. Each conflicting campaign is listed once.
 */
export function findKeywordConflicts(
  candidate: CampaignTrigger,
  others: CampaignTrigger[]
): KeywordConflict[] {
  if (!candidate.matchAnyPost) return [];
  const conflicts: KeywordConflict[] = [];
  for (const other of others) {
    if (other.id === candidate.id || !other.matchAnyPost) continue;
    const { shared, keyword } = sharedKeyword(candidate, other);
    if (!shared) continue;
    conflicts.push({
      keyword,
      campaign: { id: other.id, name: other.name, isActive: other.isActive },
    });
  }
  return conflicts;
}

/**
 * For each keyword the candidate shares with campaigns that can fire on the
 * same comment, every such campaign in the worker's order and the one whose
 * DM would go out.
 */
export function describeKeywordOverlaps(
  candidate: CampaignTrigger,
  others: CampaignTrigger[]
): KeywordOverlap[] {
  const groups = new Map<string | null, CampaignTrigger[]>();
  for (const other of others) {
    if (other.id === candidate.id || !canFireOnSameComment(candidate, other)) {
      continue;
    }
    const { shared, keyword } = sharedKeyword(candidate, other);
    if (!shared) continue;
    const key = keyword === null ? null : normalizeKeyword(keyword);
    const group = groups.get(key) ?? [];
    group.push(other);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    const ordered = [...group, candidate].sort(byWorkerOrder);
    const keyword =
      key === null
        ? null
        : candidate.keywords.find((k) => normalizeKeyword(k) === key) ?? key;
    return {
      keyword,
      campaigns: ordered.map((c) => ({
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        createdAt: c.createdAt.toISOString(),
        trigger: triggerOf(c),
      })),
      winner: { id: ordered[0].id, name: ordered[0].name },
    };
  });
}

/** Every campaign of one Instagram account, in the shape the helpers need. */
export function loadCampaignTriggers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  instagramAccountId: string,
  excludeId?: string
): Promise<CampaignTrigger[]> {
  return tx.automation.findMany({
    where: {
      workspaceId,
      instagramAccountId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: TRIGGER_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
