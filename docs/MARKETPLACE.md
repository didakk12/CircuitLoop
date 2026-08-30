# Marketplace posting

Turn a component CircuitLoop detected on a scrapped board into a for-sale
listing: generate a draft from what the detector already knows, let the user
edit it, and hand it to a provider to post.

Out of the box this needs **no credentials and makes no network call**. The
default `manual_assist` provider produces a pre-filled Facebook create-listing
link for the user to finish by hand, because Facebook has no public API that
creates a peer-to-peer Marketplace listing and pretending otherwise would be a
lie the user only discovers when their item never appears.

---

## Architecture

```
                       HTTP (session cookie, requireAuth)
                                    │
                       routes/marketplace.ts
                                    │  Zod: validation/marketplaceSchemas.ts
                       controllers/marketplaceController.ts
                                    │  DTOs: types/marketplaceDto.ts
                       services/marketplaceService.ts
                        │                         │
        ┌───────────────┘                         └──────────────┐
        │                                                        │
  provider registry                                    repositories/
  services/marketplaceProviders/registry.ts            marketplaceRepository.ts
        │  Map<string, MarketplaceProvider>                      │
        ├── ManualAssistProvider   (default, offline)            │  Cypher
        └── FacebookGraphProvider  (stub, always throws)         ▼
                                                              Neo4j
        also read-only:                        (:User)-[:OWNS]->(:Component)
        services/componentService.getComponentById            -[:LISTED_AS]->
        services/pricingHeuristic.estimatePrice           (:MarketplaceListing)
```

The scan/detection pipeline is **read only** from here. `marketplaceService`
calls the existing, unmodified `componentService.getComponentById` and nothing
else; no detection, scan, assistant, telemetry, or auth code changed.

### Provider registry

```
settings.marketplaceProvider ──► getMarketplaceProvider(name)
                                        │
                                  Map<string, MarketplaceProvider>
                                        │
                   ┌────────────────────┼────────────────────┐
                   ▼                    ▼                    ▼
          "manual_assist"       "facebook_graph"      "ebay" (future)
          ManualAssistProvider  FacebookGraphProvider  EbayProvider
```

A `Map`, not a `switch`. The service asks for a provider by name and never
learns which implementations exist, so the list of supported marketplaces lives
in exactly one place instead of being spread across every function that might
branch on it.

The interface is three members:

```ts
interface MarketplaceProvider {
  readonly name: string;                                  // registry key, persisted on the listing
  isConfigured(): boolean;                                // credentials present?
  publish(draft: MarketplaceDraft): Promise<MarketplacePublishResult>;
}
```

Providers are transport, not persistence: they receive an immutable snapshot of
the listing and cannot reach the database, mutate the entity, or decide its
status. A provider reports failure **only by throwing** — never through a return
value — so "did this fail?" is answered in exactly one place.

### Publish flow

```
POST /api/marketplace/listings/:id/publish
        │
        ├─ getListing(id, ownerId) ──► not the caller's? ──► 404, nothing else runs
        │
        ├─ already "published"? ──► return it unchanged (idempotent no-op, 200)
        │
        ├─ getMarketplaceProvider(listing.provider)
        │        └─ unknown name? ──┐
        │                           │
        ├─ Promise.race(            │
        │      provider.publish(draft),
        │      timer(marketplacePublishTimeoutMs)
        │  )                        │
        │        │                  │
        │        ├── resolves ──► status: "published" | "ready_for_manual_post"
        │        │                externalUrl / externalListingId recorded
        │        │                publishedAt stamped ONLY for "published"
        │        │                  │
        │        ├── throws ────────┤
        │        └── timer wins ────┤
        │                           ▼
        │                    status: "failed", errorMessage set
        │                    externalUrl cleared
        ▼
   applyPublishOutcome(...) ──► 200 with the listing, ALWAYS
```

**Publishing never returns a 5xx.** An unregistered provider name, a provider
that throws, and a provider that hangs past the timeout all land in
`status: "failed"` with the reason on the listing, and the endpoint still
answers 200. This mirrors `assistantService`'s degrade-gracefully posture: the
user's draft must survive an upstream outage, and the frontend has one shape to
render instead of a success path plus an error path.

---

## Endpoints

All mounted at `/api/marketplace` behind `requireAuth`. A missing or invalid
session is `401`.

| Method | Path | Body / query | Success | Notes |
|---|---|---|---|---|
| `POST` | `/listings` | `{ component_id }` | `201` new draft, `200` existing active draft | Duplicate-draft policy, below |
| `GET` | `/listings/:id` | — | `200` | `404` if not the caller's |
| `GET` | `/listings` | `?component_id=X` | `200` array, oldest first | Full history incl. published |
| `PATCH` | `/listings/:id` | `{ title?, description?, category?, price_estimate?, currency? }` | `200` | `409` once published |
| `POST` | `/listings/:id/publish` | — | `200` | Provider failure is `status:"failed"`, still 200 |

Error codes: `400` bad body/query, `401` no session, `404` unknown *or foreign*
component/listing, `409` editing a published listing.

`PATCH` is a genuine partial update — an omitted field keeps its value — and the
schema is `.strict()`, so trying to set `status`, `provider`, or `external_url`
is a `400` rather than a silent no-op. Those are the publish flow's to set.

### Response shape

```jsonc
{
  "id": "…", "component_id": "…", "provider": "manual_assist",
  "status": "draft",                     // draft | ready_for_manual_post | published | failed
  "title": "Network Switch",
  "description": "Salvaged network switch recovered from a circuit board.\n…",
  "category": "Electronics > Components > Relays & Switching",
  "price_estimate": 1.25, "currency": "USD",
  "image_url": "/api/scans/<scanId>/image",  // or null
  "external_url": null, "external_listing_id": null, "error_message": null,
  "created_at": "…", "updated_at": "…", "published_at": null
}
```

---

## Behaviour worth knowing

### Ownership: 404, never 403

Every repository query is scoped through the full chain
`(:User {id})-[:OWNS]->(:Component)-[:LISTED_AS]->(:MarketplaceListing {id})`.
There is no bare `MATCH (m:MarketplaceListing {id})` anywhere in the repository,
not even in a helper — one unscoped match would expose every user's listings to
anyone who could guess an id.

A listing or component belonging to someone else is reported as **404, not
403**, so a probing user cannot tell an existing resource they do not own from
one that does not exist. This matches how scans and components already behave.

### Duplicate drafts: one active listing per component

A component may accumulate any number of *historical* listings, but only one
**active** one at a time. Active means anything not yet successfully posted:

| Status | Active? | Editable? | Meaning |
|---|---|---|---|
| `draft` | yes | yes | Generated, never sent to a provider |
| `ready_for_manual_post` | yes | yes | `manual_assist` produced a link; **nothing was posted** |
| `failed` | yes | yes | Provider threw or timed out; edit and retry |
| `published` | no | **no** | Genuinely live upstream. Terminal. |

`POST /listings` for a component that already has an active listing returns that
listing with **200** instead of creating a second one, so clicking "List on
Marketplace" twice reopens the same draft with the user's edits intact. Once a
listing reaches `published` it stops being active, and the next `POST` creates a
genuinely new listing — which is what selling a second unit, or relisting after
a sale, needs.

### Published listings are immutable

Once `status` is `published`, `title`, `description`, `category`,
`priceEstimate`, `currency`, and `provider` are frozen and `PATCH` returns
`409`. The listing is a record of what was actually posted; letting it drift
would make it describe an item nobody advertised. The frontend hides the
Save/Publish buttons entirely in that state rather than offering buttons that
could only fail.

The guard exists twice — in the service and again as a `status <> "published"`
clause in the Cypher — because the read and the write are two statements, and a
publish landing between them must not be able to overwrite a live listing.

Re-publishing an already-published listing is an idempotent **no-op** returning
200, not a 409: posting a second copy upstream and overwriting the ids recording
the first is exactly what immutability exists to prevent.

### Image stability

`scanId` is read once from `ComponentDetail.scanId` at creation and stored
directly on the listing. `image_url` is built from that stored value
(`/api/scans/{scanId}/image`, the existing ownership-checked endpoint — no new
image route was added), so a listing keeps showing the photo it was written
about even if the component is later re-parented to a different scan.

### Draft generation

- **Title** comes from `label ?? type` — the server-side mirror of the
  frontend's `componentIdentity()`. It is **never** the OCR marking
  (`Component.name`): a listing headed "CISCO SG300-52" advertises a brand
  string read off the part rather than the thing being sold. The marking appears
  in the description, labelled as a marking.
- **Description** is templated from the type, the marking when present, an
  honest condition caveat (`uncertain`/`unknown` say the part was not verified
  rather than implying it works), and an explicit "estimate only" price
  disclaimer.
- **Category** is a total `ComponentType → category` lookup, so adding a
  component type is a compile error here rather than a silent fallthrough.
- **Price** comes from `pricingHeuristic.estimatePrice(type, condition)` — a
  base-price-by-type table times a condition multiplier, with a floor so no
  listing renders as free. It is a starting point the seller edits, not an
  appraisal, and nothing in it has seen a real marketplace.

### Structured logging

One line per event, `[ISO] [LEVEL] {json}`:

```ts
{ event, entityType: "marketplace_listing", entityId?, state?, error?, timestamp }
```

Events: `draft_created`, `draft_reused`, `draft_updated`, `publish_requested`,
`publish_succeeded`, `publish_failed` (carries the provider name and the error),
`publish_skipped_already_published`.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CIRCUITLOOP_MARKETPLACE_PROVIDER` | `manual_assist` | Registry name of the provider used to publish |
| `FACEBOOK_MARKETPLACE_CREATE_URL` | `https://www.facebook.com/marketplace/create/item` | Where `manual_assist` sends the user. Not secret |
| `FACEBOOK_APP_ID` | *(unset)* | Meta app id for the future Graph provider. Optional, secret |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | *(unset)* | Page token for the Graph provider. Optional, secret |
| `FACEBOOK_CATALOG_ID` | *(unset)* | Commerce catalog to post into. Optional, secret |
| `CIRCUITLOOP_MARKETPLACE_PUBLISH_TIMEOUT_MS` | `30000` | Hard ceiling on one `provider.publish()` call |

All three Meta values are optional in the same sense as `GEMINI_API_KEY`: absent
simply means `FacebookGraphProvider.isConfigured()` reports false. They are read
only through the typed `settings` object, are never logged, and never reach the
frontend — `FacebookGraphProvider`'s error messages are asserted in the test
suite to contain no credential value.

### Neo4j

One new node label and one new relationship, both additive:

```
(:User)-[:OWNS]->(:Component)-[:LISTED_AS]->(:MarketplaceListing)
```

Schema bootstrap (`db/schema.ts`, all `IF NOT EXISTS`, safe on every startup):

- `marketplacelisting_id_unique` constraint
- `marketplacelisting_status_index` — backs the duplicate-active-draft check
- `marketplacelisting_component_id_index` — backs the per-component listing lookup

`componentId` and `scanId` are both denormalised onto the listing; ownership is
never stored on it and is always derived through the component.

---

## Adding a provider

Two steps, and nothing outside `marketplaceProviders/` changes.

1. Implement the interface:

```ts
// services/marketplaceProviders/EbayProvider.ts
import { settings } from "../../config/env.js";
import type { MarketplaceDraft, MarketplaceProvider, MarketplacePublishResult }
  from "./MarketplaceProvider.js";

export class EbayProvider implements MarketplaceProvider {
  readonly name = "ebay";

  isConfigured(): boolean {
    return Boolean(settings.ebayApiKey); // add to config/env.ts + .env.example
  }

  async publish(draft: MarketplaceDraft): Promise<MarketplacePublishResult> {
    // Throw on failure — never return a fake success. publishDraft catches it
    // and records status:"failed" with your message.
    const listingId = await postToEbay(draft);
    return {
      status: "published",
      externalUrl: `https://www.ebay.com/itm/${listingId}`,
      externalListingId: listingId,
    };
  }
}
```

2. Register it:

```ts
// services/marketplaceProviders/registry.ts
registerMarketplaceProvider(new EbayProvider());
```

Then set `CIRCUITLOOP_MARKETPLACE_PROVIDER=ebay`. No change to the service,
controller, routes, repository, or schema.

Two rules a provider must honour:

- **Never resolve with a fake success.** Returning `status: "published"` when
  nothing was posted tells the user their component is for sale when it is not.
  Throw instead — that is what `status: "failed"` is for.
- **Only claim `published` when the listing genuinely exists upstream.** Use
  `ready_for_manual_post` when you have merely produced a link. Only
  `published` stamps `publishedAt` and freezes the listing.

Registration is exported (`registerMarketplaceProvider` /
`unregisterMarketplaceProvider`), which is also how the test suite installs
fakes — a never-resolving one for the timeout test, a throwing one for the
failure test — on the same code path production uses.

---

## Troubleshooting

**Everything I publish comes back `ready_for_manual_post`, never `published`.**
Working as designed. `manual_assist` is the default and posts nothing; it hands
you a create-listing link in `external_url`. The listing stays editable because
nothing was actually advertised.

**`status: "failed"`, `error_message: "facebook_graph: … not configured …"`.**
`FacebookGraphProvider` needs both `FACEBOOK_PAGE_ACCESS_TOKEN` and
`FACEBOOK_CATALOG_ID`; a token with no catalog to post into is as unusable as
neither. Set both, or switch back to
`CIRCUITLOOP_MARKETPLACE_PROVIDER=manual_assist`.

**`status: "failed"`, `error_message: "facebook_graph: … not implemented yet …"`.**
Also expected. Real Graph API wiring does not exist; the stub throws rather than
faking a success. Use `manual_assist`.

**`status: "failed"`, `error_message: "… Unknown marketplace provider 'x' …"`.**
`CIRCUITLOOP_MARKETPLACE_PROVIDER` names a provider nobody registered — usually a
typo. The message lists the registered names. Note the draft is not lost: fix the
variable, restart, and publish again.

**`status: "failed"`, `error_message: "… Publishing timed out after 30000ms"`.**
The provider never settled. The listing is untouched apart from the failure
record and can be edited and re-published. Raise
`CIRCUITLOOP_MARKETPLACE_PUBLISH_TIMEOUT_MS` only if a provider is legitimately
slow; a hung provider is a provider bug.

**404 on a listing I can see in the database.** Ownership. Every query runs
through `(:User)-[:OWNS]->(:Component)-[:LISTED_AS]->`, and a listing whose
component is not owned by the session's user is reported as missing. Check that
`(:User)-[:OWNS]->(:Component)` exists for that component — the startup data
migration in `db/schema.ts` backfills it from scan ownership.

**409 when saving edits.** The listing reached `published` and is frozen. Create
a new listing for the component instead; the duplicate-draft policy explicitly
allows that once the previous one is published.

**A second POST returned 200 and an old listing instead of a new one.** The
duplicate-draft policy. The component already has an active listing, and
returning it preserves whatever the user had already typed. Publish or let the
existing listing reach `published` before creating a new one.

**Known limitation — deleting a component leaves its listings behind.**
`componentRepository.deleteComponent` cascades test results and commands but not
`MarketplaceListing` nodes, so deleting a component orphans them. They are
unreachable through the API (every query traverses the component), so this is a
storage-hygiene wart rather than a leak. Cascading it would mean editing the
component repository, which is outside this feature's scope; clean up with:

```cypher
MATCH (m:MarketplaceListing)
WHERE NOT ( (:Component)-[:LISTED_AS]->(m) )
DETACH DELETE m
```

---

## Tests

```bash
cd backend && npm run typecheck && npm test
```

No Meta credentials, no network, and no database are needed for the majority of
the suite:

| File | Needs Neo4j | Covers |
|---|---|---|
| `tests/pricingHeuristic.test.ts` | no | Every `ComponentType × ComponentCondition` pair |
| `tests/marketplaceProviders.test.ts` | no | Registry lookup/registration/unknown name; both providers; no credential leaks |
| `tests/marketplaceService.test.ts` | no | Draft generation, duplicate drafts, 409 immutability, publish timeout, provider throw, ownership |
| `tests/marketplaceApi.test.ts` | partly | The 401 sweep runs without a database; the full HTTP flow needs one |
| `tests/marketplaceRepository.test.ts` | yes | The real Cypher, via transaction rollback |

Integration files skip themselves with a warning when Neo4j is unreachable, so
the suite is green either way — check the summary for skips before reading a
pass as full coverage.
