import { z } from "zod";

// Campaign fields as the panel and the integration API accept them. Both share
// one definition so a rule added for the panel also binds the API.

const campaignFields = {
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional().nullable(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional().default(false),
  matchAnyPost: z.boolean().optional().default(false),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
  matchAnyWord: z.boolean().optional().default(false),
  dmTriggerEnabled: z.boolean().optional().default(false),
  dmMessage: z.string().min(1).max(1000),
  openingDmEnabled: z.boolean().optional().default(false),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional().default(false),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional().default(false),
  followUpMessage: z.string().max(1000).optional().nullable(),
  // Minutes to wait before the follow-up. Capped at 24h so it stays inside
  // Instagram's messaging window.
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
  publicReplyEnabled: z.boolean().optional().default(false),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z
    .array(z.string().max(1000))
    .max(10)
    .optional()
    .default([]),
  // Empty string means "no tracked link"; a URL sets one.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Optional second tracked link, rendered as a second DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  wholeWordMatch: z.boolean().optional().default(true),
};

type CreateShape = {
  matchAnyPost: boolean;
  pendingNextReel: boolean;
  postId?: string | null;
  matchAnyWord: boolean;
  keywords: string[];
  openingDmEnabled: boolean;
  openingDmMessage?: string | null;
  openingDmButtonLabel?: string | null;
};

function withCreateRules<T extends z.ZodType<CreateShape>>(schema: T) {
  return (
    schema
      // A campaign must target a specific post, any post, or the next reel.
      .refine(
        (d) => d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
        { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
      )
      // And it must match either specific words or any word.
      .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
        message: "Add at least one keyword, or match any word",
        path: ["keywords"],
      })
      // An opening DM needs both a message and a button label.
      .refine(
        (d) =>
          !d.openingDmEnabled ||
          (Boolean(d.openingDmMessage?.trim()) &&
            Boolean(d.openingDmButtonLabel?.trim())),
        { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
      )
  );
}

export const campaignCreateSchema = withCreateRules(z.object(campaignFields));

// Integration clients cannot choose whether a campaign starts active: it is
// always created paused, and switching it on is a separate permission.
export const apiCampaignCreateSchema = withCreateRules(
  z.object(campaignFields).omit({ isActive: true }).strict()
);

const updateFields = {
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
};

export const campaignUpdateSchema = z.object(updateFields);

// Report sharing is a panel setting; the API does not touch it.
export const apiCampaignUpdateSchema = campaignUpdateSchema
  .omit({ reportShareEnabled: true })
  .strict();

export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type ApiCampaignCreateInput = z.infer<typeof apiCampaignCreateSchema>;
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;

/**
 * The campaign columns for a new campaign, with dependent fields kept
 * consistent. The caller adds workspace, account, report slug and links.
 */
export function buildCampaignCreateData(
  input: ApiCampaignCreateInput & { isActive?: boolean }
) {
  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    input;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    input.publicReplyMessages.length > 0
      ? input.publicReplyMessages
      : input.publicReplyMessage
        ? [input.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    name: input.name,
    goal: input.goal,
    // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
    postId: isSpecificPost ? input.postId : null,
    postUrl: isSpecificPost ? input.postUrl : null,
    pendingNextReel,
    matchAnyPost,
    keywords: matchAnyWord ? [] : input.keywords,
    matchAnyWord,
    dmTriggerEnabled: input.dmTriggerEnabled,
    dmMessage: input.dmMessage,
    openingDmEnabled,
    openingDmMessage: openingDmEnabled ? input.openingDmMessage || null : null,
    openingDmButtonLabel: openingDmEnabled
      ? input.openingDmButtonLabel || null
      : null,
    linkButtonLabel: input.linkButtonLabel || null,
    requireFollow: input.requireFollow,
    followPromptMessage: input.requireFollow
      ? input.followPromptMessage || null
      : null,
    followPromptButtonLabel: input.requireFollow
      ? input.followPromptButtonLabel || null
      : null,
    followUpEnabled: input.followUpEnabled,
    followUpMessage: input.followUpEnabled
      ? input.followUpMessage || null
      : null,
    followUpDelayMinutes: input.followUpEnabled
      ? input.followUpDelayMinutes
      : 0,
    publicReplyEnabled: input.publicReplyEnabled,
    publicReplyMessages: input.publicReplyEnabled ? publicReplyList : [],
    publicReplyMessage: input.publicReplyEnabled
      ? publicReplyList[0] ?? input.publicReplyMessage ?? null
      : null,
    isActive: input.isActive ?? false,
    wholeWordMatch: input.wholeWordMatch,
  };
}

/**
 * Split an update into campaign columns and link changes, and keep dependent
 * fields consistent: any-word clears keywords; a disabled opening DM,
 * follow gate or follow-up clears its settings.
 */
export function normalizeCampaignUpdate(data: CampaignUpdateInput) {
  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    ...automationData
  } = data;

  if (automationData.matchAnyWord === true) automationData.keywords = [];
  if (automationData.openingDmEnabled === false) {
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
  }
  if (automationData.requireFollow === false) {
    automationData.followPromptMessage = null;
    automationData.followPromptButtonLabel = null;
  }
  if (automationData.followUpEnabled === false) {
    automationData.followUpMessage = null;
    automationData.followUpDelayMinutes = 0;
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    automationData.postId = null;
    automationData.postUrl = null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (automationData.publicReplyMessages !== undefined) {
    const list = automationData.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    automationData.publicReplyMessages = list;
    automationData.publicReplyMessage = list[0] ?? null;
  }
  if (automationData.publicReplyEnabled === false) {
    automationData.publicReplyMessages = [];
    automationData.publicReplyMessage = null;
  }

  return {
    automationData,
    links: {
      primaryUrl: trackedDestinationUrl,
      secondaryUrl: secondaryDestinationUrl,
      secondaryLabel: secondaryButtonLabel,
    },
  };
}
