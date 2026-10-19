import { describe, expect, it } from "vitest";
import {
  describeKeywordOverlaps,
  findKeywordConflicts,
  type CampaignTrigger,
} from "../lib/campaigns/keyword-conflicts";
import { normalizeKeyword } from "../lib/utils/keyword-matcher";

const campaign = (over: Partial<CampaignTrigger> & { id: string }): CampaignTrigger => ({
  name: over.id,
  isActive: true,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  matchAnyPost: true,
  pendingNextReel: false,
  postId: null,
  matchAnyWord: false,
  wholeWordMatch: true,
  keywords: [],
  ...over,
});

describe("normalizeKeyword", () => {
  it("folds case, spacing, symbols and Latin accents like the matcher", () => {
    expect(normalizeKeyword(" HUNTER ")).toBe("hunter");
    expect(normalizeKeyword("Huntér!")).toBe("hunter");
  });
});

describe("findKeywordConflicts", () => {
  it("finds an any-post campaign that already uses the keyword, written differently", () => {
    const candidate = campaign({ id: "new", keywords: ["Hunter"] });
    const others = [campaign({ id: "old", keywords: [" HUNTER "] })];
    expect(findKeywordConflicts(candidate, others)).toEqual([
      { keyword: "Hunter", campaign: { id: "old", name: "old", isActive: true } },
    ]);
  });

  it("reports the keyword without the client's stray spaces", () => {
    const [conflict] = findKeywordConflicts(campaign({ id: "new", keywords: ["hunter "] }), [campaign({ id: "old", keywords: ["HUNTER"] })]);
    expect(conflict.keyword).toBe("hunter");
    const post = campaign({ id: "post", matchAnyPost: false, postId: "1", keywords: [" hunter"] });
    expect(describeKeywordOverlaps(post, [campaign({ id: "old", keywords: ["HUNTER"] })])[0].keyword).toBe("hunter");
  });

  it("folds accents", () => {
    const candidate = campaign({ id: "new", keywords: ["huntér"] });
    expect(findKeywordConflicts(candidate, [campaign({ id: "old", keywords: ["hunter"] })])).toHaveLength(1);
  });

  it("counts paused campaigns too", () => {
    const candidate = campaign({ id: "new", keywords: ["hunter"] });
    const others = [campaign({ id: "old", keywords: ["hunter"], isActive: false })];
    expect(findKeywordConflicts(candidate, others)[0].campaign.isActive).toBe(false);
  });

  it("treats an any-word any-post campaign as using every keyword", () => {
    const anyWord = campaign({ id: "all", matchAnyWord: true });
    expect(findKeywordConflicts(campaign({ id: "new", keywords: ["x"] }), [anyWord])).toEqual([
      { keyword: null, campaign: { id: "all", name: "all", isActive: true } },
    ]);
    expect(findKeywordConflicts(anyWord, [campaign({ id: "old", keywords: ["x"] })])).toHaveLength(1);
  });

  it("finds a keyword that contains another campaign's keyword as a word", () => {
    // Every "hunter cat" comment also matches HUNTER, so one campaign never DMs.
    const older = campaign({ id: "old", keywords: ["HUNTER"] });
    expect(findKeywordConflicts(campaign({ id: "new", keywords: ["hunter cat"] }), [older])).toEqual([
      { keyword: "hunter cat", campaign: { id: "old", name: "old", isActive: true } },
    ]);
    const longer = campaign({ id: "old", keywords: ["hunter cat"] });
    expect(findKeywordConflicts(campaign({ id: "new", keywords: ["HUNTER"] }), [longer])).toHaveLength(1);
  });

  it("finds a partial-match keyword inside a longer word", () => {
    const partial = campaign({ id: "old", keywords: ["cat"], wholeWordMatch: false });
    expect(findKeywordConflicts(campaign({ id: "new", keywords: ["catsniffer"] }), [partial])).toHaveLength(1);
  });

  it("does not treat a whole-word keyword as part of a longer word", () => {
    const whole = campaign({ id: "old", keywords: ["cat"] });
    expect(findKeywordConflicts(campaign({ id: "new", keywords: ["catsniffer"] }), [whole])).toEqual([]);
  });

  it("ignores campaigns bound to a post or the next reel", () => {
    const candidate = campaign({ id: "new", keywords: ["hunter"] });
    const others = [
      campaign({ id: "post", matchAnyPost: false, postId: "1", keywords: ["hunter"] }),
      campaign({ id: "reel", matchAnyPost: false, pendingNextReel: true, keywords: ["hunter"] }),
    ];
    expect(findKeywordConflicts(candidate, others)).toEqual([]);
  });

  it("ignores the candidate itself and different keywords", () => {
    const candidate = campaign({ id: "same", keywords: ["hunter"] });
    expect(findKeywordConflicts(candidate, [campaign({ id: "same", keywords: ["hunter"] }), campaign({ id: "b", keywords: ["bomber"] })])).toEqual([]);
  });
});

describe("describeKeywordOverlaps", () => {
  it("names the older any-post campaign as the winner over a post-bound one", () => {
    const candidate = campaign({ id: "post", matchAnyPost: false, postId: "1", keywords: ["hunter"], createdAt: new Date("2026-10-18T00:00:00Z") });
    const older = campaign({ id: "any", keywords: ["HUNTER"], createdAt: new Date("2026-10-01T00:00:00Z") });
    expect(findKeywordConflicts(candidate, [older])).toEqual([]);
    const [overlap] = describeKeywordOverlaps(candidate, [older]);
    expect(overlap.keyword).toBe("hunter");
    expect(overlap.winner).toEqual({ id: "any", name: "any" });
    expect(overlap.campaigns.map((c) => [c.id, c.trigger])).toEqual([["any", "any_post"], ["post", "post"]]);
  });

  it("reports a post campaign whose keyword contains an older any-post keyword", () => {
    const candidate = campaign({ id: "post", matchAnyPost: false, postId: "1", keywords: ["hunter cat"], createdAt: new Date("2026-10-18T00:00:00Z") });
    const [overlap] = describeKeywordOverlaps(candidate, [campaign({ id: "any", keywords: ["HUNTER"] })]);
    expect(overlap).toMatchObject({ keyword: "hunter cat", winner: { id: "any" } });
  });

  it("does not overlap campaigns bound to different posts", () => {
    const candidate = campaign({ id: "a", matchAnyPost: false, postId: "1", keywords: ["hunter"] });
    expect(describeKeywordOverlaps(candidate, [campaign({ id: "b", matchAnyPost: false, postId: "2", keywords: ["hunter"] })])).toEqual([]);
  });

  it("an any-post candidate overlaps post-bound and next-reel campaigns", () => {
    const candidate = campaign({ id: "any", keywords: ["hunter"], createdAt: new Date("2026-10-18T00:00:00Z") });
    const reel = campaign({ id: "reel", matchAnyPost: false, pendingNextReel: true, keywords: ["hunter"], createdAt: new Date("2026-10-02T00:00:00Z") });
    const post = campaign({ id: "post", matchAnyPost: false, postId: "9", keywords: ["hunter"], createdAt: new Date("2026-10-03T00:00:00Z") });
    const [overlap] = describeKeywordOverlaps(candidate, [post, reel]);
    expect(overlap.campaigns.map((c) => c.id)).toEqual(["reel", "post", "any"]);
    expect(overlap.winner.id).toBe("reel");
  });

  it("breaks a createdAt tie by id so the report is stable", () => {
    const at = new Date("2026-10-05T00:00:00Z");
    const candidate = campaign({ id: "b", matchAnyPost: false, postId: "1", keywords: ["x"], createdAt: at });
    const [overlap] = describeKeywordOverlaps(candidate, [campaign({ id: "a", keywords: ["x"], createdAt: at })]);
    expect(overlap.winner.id).toBe("a");
  });
});
