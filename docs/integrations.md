# API and MCP

Workspace owners and admins can create keys at **API & MCP** (`/integrations`).
Each key has one or more scopes and lives 30, 60, 90, 180 or 365 days
(default: 30). Existing keys are never extended. Copy the token at creation; only its
SHA-256 hash is stored. Revocation takes effect on subsequent authenticated requests.
Use HTTPS and never put a token in a URL, source control, screenshots or prompts.
Keys belong to the workspace, not their creator, and remain valid until expiry,
revocation or workspace deletion. Review keys when team members leave.

Apply migrations and regenerate Prisma before starting the new web version:

```sh
npm run db:migrate
npm run db:generate
```

The additive migrations create `ServiceKey` and add two nullable columns to
`Automation` (`createdByServiceKeyId`, `lastEditedByServiceKeyId`); they do not
change existing campaigns, authentication providers or worker behavior. `REDIS_URL` is required for service
requests. Each key allows 120 requests per fixed 60-second window. Redis failures
reject requests with 503 instead of disabling the limiter.

## Scopes

| Scope | Allows |
|---|---|
| `campaigns:read` | List and read campaigns, campaign stats and recent posts. |
| `campaigns:write` | Create campaigns (always paused) and edit **paused** campaigns. |
| `campaigns:activate` | Switch campaigns on or off, and edit campaigns that are live. |

A key with `campaigns:write` but not `campaigns:activate` can prepare campaigns
that a person then switches on in the panel; switching a campaign on there is
the approval. Keys with `campaigns:activate` can start sending DMs without
anyone looking, so give that scope only to clients you would trust with the
panel.

## MCP clients

Connect to `https://YOUR-DOMAIN/api/mcp` using Streamable HTTP and a custom header:

```text
Authorization: Bearer <service-key>
```

There is no OAuth server, dynamic client registration or token in the URL.
In Claude, use **No authentication** plus this custom request header **only if
your client offers request headers**. Clients requiring OAuth are not supported.
Never switch to public access to work around a client limitation.

Tools (all read-only; scope `campaigns:read`):

- `list_campaigns`: up to 100 compact campaign summaries, newest first.
- `get_campaign` with `{ "id": "..." }`: settings, ordered `trackedLinks`, and
  `trackedDestinationUrl`, `secondaryDestinationUrl`, `secondaryButtonLabel`.
  Missing links are `[]` / `null`. Link order matches the existing DM worker.
- `get_campaign_stats` with `{ "id": "..." }`: aggregate send outcomes and raw
  link requests. These are **not** unique recipients or CRM conversions.

Example safe verification: ask your client to list campaigns, then read one
campaign's destination URLs without changing anything. MCP has no write tools;
campaign writes are REST only.

## REST

Use the same Bearer header:

```text
GET /api/v1/campaigns
GET /api/v1/campaigns?id=<campaign-id>
GET /api/v1/campaigns?id=<campaign-id>&stats=1
GET /api/v1/posts?limit=25
```

`/api/v1/posts` returns the account's latest posts and reels (`limit` 1-50,
default 25; `instagramAccountId` optional) with `id`, `caption`, `permalink`,
`timestamp`, `media_type` and `media_product_type`, so a client can bind a
campaign to a post by `id`. When Instagram fails it answers 502 without
Instagram's message.

Responses use `{ "data": ... }`. Lists are capped at 100; pagination is not yet
provided. Detail responses use an explicit safe projection: no provider tokens,
report-share secrets, recipient logs or account relations. A campaign outside
the key's workspace returns 404. Invalid/expired/revoked keys return 401, missing
scope returns 403, rate limits return 429. Results are `Cache-Control: no-store`.

Admin key management uses session authentication at `/api/integrations/keys`:
GET lists metadata (never hashes/tokens), POST creates a key, DELETE with `?id=`
revokes it. A supplied Origin must match `NEXTAUTH_URL` (or the request origin).
JSON request bodies are bounded to 64 KiB including streamed/chunked requests.

## Writing campaigns

```text
POST  /api/v1/campaigns              campaigns:write
PATCH /api/v1/campaigns?id=<id>      campaigns:write (+ campaigns:activate, see below)
```

Bodies take the same fields and rules as the panel's campaign form: `name`,
`dmMessage`, a trigger (`matchAnyPost`, `pendingNextReel`, or `postId` with
`postUrl`), `keywords` (up to 10) or `matchAnyWord`, `linkButtonLabel`,
`trackedDestinationUrl`, `secondaryDestinationUrl` + `secondaryButtonLabel` (a
second DM button), `publicReplyEnabled` + `publicReplyMessages`, the opening
DM, follow gate and follow-up fields, and `instagramAccountId` (default: the
most recently connected account). Unknown fields are rejected with 400 and
`details`.

- A created campaign is always paused; `isActive` is not accepted on create.
- `isActive` in a PATCH needs `campaigns:activate`.
- A key without `campaigns:activate` cannot edit a live campaign (409); pause it
  in the panel first.
- A key without `campaigns:activate` cannot change the destination URLs of a
  campaign that has already sent DMs (409): the buttons in delivered DMs keep
  using those links, active or not.
- An any-post campaign cannot use a keyword that another any-post campaign of
  the same account already answers to, paused or not. Keywords are compared
  like the matcher compares comments (case, spacing, symbols and Latin accents
  ignored), and a keyword that contains another one counts too: `hunter cat`
  collides with a whole-word `HUNTER`, and `catsniffer` with a partial-match
  `cat`. The answer is 409:

```json
{ "error": "Keyword already used by another any-post campaign",
  "conflicts": [{ "keyword": "hunter", "campaign": { "id": "...", "name": "...", "isActive": false } }] }
```

Creates and keyword edits of one workspace run one at a time; a save that
waits more than 3 seconds for another answers 503 and can be retried.

Instagram allows one private reply per comment and campaigns are tried oldest
first, so other overlaps (an any-post campaign and a post campaign with the
same word) are allowed but only one of them sends the DM. Every write answers
`{ "data": <campaign>, "keywordOverlaps": [...] }`, where each overlap lists the
campaigns that answer that keyword on the same comments, oldest first, and the
`winner` whose DM goes out when the campaigns are active (the worker skips
paused ones). Each matching campaign still posts its own public reply.

```sh
curl -sS -X POST https://YOUR-DOMAIN/api/v1/campaigns \
  -H "Authorization: Bearer $OPENREPLY_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Hunter","matchAnyPost":true,"keywords":["HUNTER"],
       "dmMessage":"Here is the link","linkButtonLabel":"Shop",
       "trackedDestinationUrl":"https://example.com/hunter"}'
```

Campaigns record which key created and last edited them. The campaign list
shows "API · <key name>" on campaigns a key created and "Edited by API ·
<key name>" on campaigns a key changed last, and asks for confirmation before
switching the latter on. A save in the panel clears the last API editor;
switching a campaign on or off does not, and a duplicate is not attributed to
the key.

## Verification

`npm test` includes mocked authentication/route tests. Set `TEST_DATABASE_URL`
to a disposable local PostgreSQL database to also exercise full migrations,
workspace isolation, deterministic link ordering and fixed key expiration.
The DB suites create and remove their own schemas.

For actual HTTP verification, migrate a **disposable local** database, start
the web app with that `DATABASE_URL`, local `REDIS_URL` and loopback
`NEXTAUTH_URL`, then run:

```sh
TEST_BASE_URL=http://127.0.0.1:3317 \
TEST_DATABASE_URL=postgresql://postgres:local-test@127.0.0.1:54456/postgres \
npx tsx scripts/verify-readonly-integrations.ts
```

The script refuses non-loopback URLs, creates dummy fixtures and keys, and
removes its test user/workspace in `finally`. It must never run against a real
deployment, including one tunneled through localhost. No Meta messages are sent.
