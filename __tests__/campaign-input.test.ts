import { describe, expect, it } from "vitest";
import {
  apiCampaignCreateSchema,
  apiCampaignUpdateSchema,
  buildCampaignCreateData,
  campaignCreateSchema,
  normalizeCampaignUpdate,
} from "../lib/campaigns/input";

const valid = {
  name: "Hunter",
  matchAnyPost: true,
  keywords: ["HUNTER"],
  dmMessage: "Here is the link",
};

describe("campaign create input", () => {
  it("drops the post of an any-post campaign", () => {
    const input = campaignCreateSchema.parse({ ...valid, postId: "123", postUrl: "https://instagram.com/p/1" });
    expect(buildCampaignCreateData(input)).toMatchObject({ postId: null, postUrl: null, matchAnyPost: true });
  });

  it("keeps the post of a specific-post campaign", () => {
    const input = campaignCreateSchema.parse({ ...valid, matchAnyPost: false, postId: "123", postUrl: "https://instagram.com/p/1" });
    expect(buildCampaignCreateData(input)).toMatchObject({ postId: "123", postUrl: "https://instagram.com/p/1" });
  });

  it("clears keywords when any word matches", () => {
    const input = campaignCreateSchema.parse({ ...valid, matchAnyWord: true });
    expect(buildCampaignCreateData(input).keywords).toEqual([]);
  });

  it("trims public reply variations and mirrors the first into the legacy field", () => {
    const input = campaignCreateSchema.parse({ ...valid, publicReplyEnabled: true, publicReplyMessages: [" a ", ""] });
    expect(buildCampaignCreateData(input)).toMatchObject({ publicReplyMessages: ["a"], publicReplyMessage: "a" });
  });

  it("drops follow-up settings when the follow-up is off", () => {
    const input = campaignCreateSchema.parse({ ...valid, followUpMessage: "Later", followUpDelayMinutes: 30 });
    expect(buildCampaignCreateData(input)).toMatchObject({ followUpMessage: null, followUpDelayMinutes: 0 });
  });

  it("keeps the panel default of a new campaign being active", () => {
    expect(buildCampaignCreateData(campaignCreateSchema.parse(valid)).isActive).toBe(true);
  });

  it("API create refuses isActive and unknown fields", () => {
    expect(apiCampaignCreateSchema.safeParse(valid).success).toBe(true);
    expect(apiCampaignCreateSchema.safeParse({ ...valid, isActive: true }).success).toBe(false);
    expect(apiCampaignCreateSchema.safeParse({ ...valid, foo: 1 }).success).toBe(false);
  });

  it("API create still requires a trigger and a keyword", () => {
    const noTrigger = apiCampaignCreateSchema.safeParse({ ...valid, matchAnyPost: false });
    expect(noTrigger.success).toBe(false);
    expect(noTrigger.error?.flatten().fieldErrors.postId).toBeDefined();
    const noKeyword = apiCampaignCreateSchema.safeParse({ ...valid, keywords: [] });
    expect(noKeyword.error?.flatten().fieldErrors.keywords).toBeDefined();
  });
});

describe("campaign update input", () => {
  it("clears the post when switching to any post", () => {
    const { automationData } = normalizeCampaignUpdate({ matchAnyPost: true, postId: "x", postUrl: "https://instagram.com/p/1" });
    expect(automationData).toMatchObject({ postId: null, postUrl: null });
  });

  it("resets the follow-up delay when the follow-up is turned off", () => {
    expect(normalizeCampaignUpdate({ followUpEnabled: false }).automationData).toMatchObject({ followUpMessage: null, followUpDelayMinutes: 0 });
  });

  it("separates link fields from campaign fields", () => {
    const result = normalizeCampaignUpdate({ name: "New", trackedDestinationUrl: "https://example.com", secondaryButtonLabel: "Docs" });
    expect(result.automationData).toEqual({ name: "New" });
    expect(result.links).toEqual({ primaryUrl: "https://example.com", secondaryUrl: undefined, secondaryLabel: "Docs" });
  });

  it("API update refuses unknown fields and the panel-only report toggle", () => {
    expect(apiCampaignUpdateSchema.safeParse({ name: "x" }).success).toBe(true);
    expect(apiCampaignUpdateSchema.safeParse({ foo: 1 }).success).toBe(false);
    expect(apiCampaignUpdateSchema.safeParse({ reportShareEnabled: false }).success).toBe(false);
  });
});
