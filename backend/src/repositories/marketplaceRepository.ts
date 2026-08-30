/**
 * Data access for (:MarketplaceListing) nodes and their
 * `(:Component)-[:LISTED_AS]->(:MarketplaceListing)` relationship.
 *
 * **Every** query in this file — create, read, list, update, publish — is
 * scoped through the full ownership chain
 * `(:User {id: $ownerId})-[:OWNS]->(:Component)-[:LISTED_AS]->(:MarketplaceListing {id: $id})`.
 * There is deliberately no bare `MATCH (m:MarketplaceListing {id: $id})`
 * anywhere here, not even in a helper: a single unscoped match would expose
 * every user's listings to anyone who could guess an id, and the scoping is
 * only reliable if it is unconditional.
 *
 * A listing belonging to another user is indistinguishable from one that does
 * not exist — the repository returns `null` and the service layer turns that
 * into a `404 NotFoundError`, never a `403`. That mirrors how
 * `componentRepository` already hides other users' components.
 */

import type { Node } from "neo4j-driver";

import { toIsoString, toNullableIsoString, toNumber } from "../db/mappers.js";
import { readQuery, writeQuery, type QueryRunner } from "../db/session.js";
import { NodeLabel, RelationshipType, type MarketplaceListing, type MarketplaceListingStatus } from "../types/entities.js";
import { newId } from "../utils/ids.js";

/**
 * Statuses that count as an *active* listing for the duplicate-draft policy:
 * everything a component can be in before it has actually been posted.
 *
 * `published` is excluded, which is the whole point — once a listing has gone
 * out, the component is free to be listed again (re-listing after a sale, or a
 * second unit), and a new POST creates a genuinely new listing instead of
 * handing back the old published one.
 */
export const ACTIVE_LISTING_STATUSES: readonly MarketplaceListingStatus[] = [
  "draft",
  "ready_for_manual_post",
  "failed",
];

/** Everything needed to create a listing. `status` is always `draft` at birth, so it isn't an input. */
export interface MarketplaceListingInput {
  componentId: string;
  /** Captured once from `ComponentDetail.scanId` at creation — see entities.ts on why it is stored, not re-derived. */
  scanId: string | null;
  provider: string;
  title: string;
  description: string;
  category: string;
  priceEstimate: number;
  currency: string;
}

/** The subset of fields a PATCH may change. Immutable once the listing is `published`. */
export interface MarketplaceListingContentUpdate {
  title: string;
  description: string;
  category: string;
  priceEstimate: number;
  currency: string;
}

/** The outcome of a publish attempt, as persisted onto the listing. */
export interface MarketplacePublishOutcome {
  status: MarketplaceListingStatus;
  externalUrl: string | null;
  externalListingId: string | null;
  errorMessage: string | null;
}

/**
 * The one ownership-scoped MATCH clause every query below starts from.
 *
 * Written once and reused so no future query can accidentally omit a hop: the
 * chain must run User → Component → listing, and interpolating this constant is
 * strictly easier than retyping it wrongly.
 */
const OWNED_LISTING_MATCH =
  `MATCH (:${NodeLabel.User} {id: $ownerId})-[:${RelationshipType.OWNS}]->` +
  `(c:${NodeLabel.Component})-[:${RelationshipType.LISTED_AS}]->(m:${NodeLabel.MarketplaceListing} {id: $id})`;

function toMarketplaceListing(node: Node): MarketplaceListing {
  const p = node.properties;
  return {
    id: String(p["id"]),
    componentId: String(p["componentId"]),
    scanId: p["scanId"] === null || p["scanId"] === undefined ? null : String(p["scanId"]),
    provider: String(p["provider"]),
    status: p["status"] as MarketplaceListingStatus,
    title: String(p["title"]),
    description: String(p["description"]),
    category: String(p["category"]),
    priceEstimate: toNumber(p["priceEstimate"]),
    currency: String(p["currency"]),
    externalUrl: p["externalUrl"] === null || p["externalUrl"] === undefined ? null : String(p["externalUrl"]),
    externalListingId:
      p["externalListingId"] === null || p["externalListingId"] === undefined
        ? null
        : String(p["externalListingId"]),
    errorMessage: p["errorMessage"] === null || p["errorMessage"] === undefined ? null : String(p["errorMessage"]),
    createdAt: toIsoString(p["createdAt"]),
    updatedAt: toIsoString(p["updatedAt"]),
    publishedAt: toNullableIsoString(p["publishedAt"]),
  };
}

/**
 * Creates a listing hanging off a component the caller owns.
 *
 * Returns `null` when `input.componentId` is not a component owned by
 * `ownerId` — the service turns that into a `NotFoundError` for the
 * *component*, so a caller probing other users' component ids learns nothing.
 */
export async function createListing(
  input: MarketplaceListingInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ m: Node }>(
      `MATCH (:${NodeLabel.User} {id: $ownerId})-[:${RelationshipType.OWNS}]->(c:${NodeLabel.Component} {id: $componentId})
       CREATE (c)-[:${RelationshipType.LISTED_AS}]->(m:${NodeLabel.MarketplaceListing} {
         id: $id, componentId: $componentId, scanId: $scanId, provider: $provider,
         status: "draft", title: $title, description: $description, category: $category,
         priceEstimate: $priceEstimate, currency: $currency,
         externalUrl: null, externalListingId: null, errorMessage: null,
         createdAt: datetime(), updatedAt: datetime(), publishedAt: null
       })
       RETURN m`,
      { id: newId(), ownerId, ...input },
    );
    const record = result.records[0];
    return record ? toMarketplaceListing(record.get("m")) : null;
  });
}

/**
 * The component's current *active* listing, if it has one — the duplicate-draft
 * check behind `POST /api/marketplace/listings`.
 *
 * Newest-first with `LIMIT 1`: historical data written before this policy
 * existed (or by a future concurrent create) could in principle leave two
 * active listings on one component, and handing back the most recent one is
 * both the least surprising answer and self-healing.
 *
 * Returns `null` for a component the user doesn't own, exactly as for one with
 * no active listing — the caller checks component ownership separately, so this
 * never has to distinguish them.
 */
export async function findActiveListingForComponent(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ m: Node }>(
      `MATCH (:${NodeLabel.User} {id: $ownerId})-[:${RelationshipType.OWNS}]->
             (c:${NodeLabel.Component} {id: $componentId})-[:${RelationshipType.LISTED_AS}]->(m:${NodeLabel.MarketplaceListing})
       WHERE m.status IN $activeStatuses
       RETURN m
       ORDER BY m.createdAt DESC
       LIMIT 1`,
      { componentId, ownerId, activeStatuses: [...ACTIVE_LISTING_STATUSES] },
    );
    const record = result.records[0];
    return record ? toMarketplaceListing(record.get("m")) : null;
  });
}

export async function getListingById(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ m: Node }>(`${OWNED_LISTING_MATCH}\n       RETURN m`, { id, ownerId });
    const record = result.records[0];
    return record ? toMarketplaceListing(record.get("m")) : null;
  });
}

/**
 * A component's full listing history, oldest-first.
 *
 * Returns `null` (not `[]`) when the component isn't the caller's or doesn't
 * exist, so the service can answer 404 rather than an empty list — an empty
 * array would tell a probing user that someone else's component id is real but
 * unlisted.
 */
export async function listListingsForComponent(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing[] | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ listings: Node[] }>(
      `MATCH (:${NodeLabel.User} {id: $ownerId})-[:${RelationshipType.OWNS}]->(c:${NodeLabel.Component} {id: $componentId})
       OPTIONAL MATCH (c)-[:${RelationshipType.LISTED_AS}]->(m:${NodeLabel.MarketplaceListing})
       WITH c, m ORDER BY m.createdAt ASC
       RETURN collect(m) AS listings`,
      { componentId, ownerId },
    );
    const record = result.records[0];
    if (!record) {
      return null;
    }
    return record.get("listings").map(toMarketplaceListing);
  });
}

/**
 * Applies a content edit.
 *
 * The `status <> "published"` guard is intentionally duplicated here even
 * though the service checks it first: the service's read and this write are two
 * statements, and a publish landing between them must not be able to overwrite
 * a live listing. A `null` return after a successful read therefore means
 * exactly that race, and the service reports it as the same 409 the read would
 * have.
 */
export async function updateListingContent(
  id: string,
  update: MarketplaceListingContentUpdate,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ m: Node }>(
      `${OWNED_LISTING_MATCH}
       WHERE m.status <> "published"
       SET m.title = $title, m.description = $description, m.category = $category,
           m.priceEstimate = $priceEstimate, m.currency = $currency,
           m.updatedAt = datetime()
       RETURN m`,
      { id, ownerId, ...update },
    );
    const record = result.records[0];
    return record ? toMarketplaceListing(record.get("m")) : null;
  });
}

/**
 * Records the result of a publish attempt — success, provider failure, or
 * timeout, all through this one write.
 *
 * `publishedAt` is set only on a genuine `published`: `ready_for_manual_post`
 * means nothing was posted, and stamping a publish time on it would make the
 * listing look live in every later read.
 */
export async function applyPublishOutcome(
  id: string,
  outcome: MarketplacePublishOutcome,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ m: Node }>(
      `${OWNED_LISTING_MATCH}
       SET m.status = $status, m.externalUrl = $externalUrl, m.externalListingId = $externalListingId,
           m.errorMessage = $errorMessage, m.updatedAt = datetime(),
           m.publishedAt = CASE WHEN $status = "published" THEN datetime() ELSE m.publishedAt END
       RETURN m`,
      { id, ownerId, ...outcome },
    );
    const record = result.records[0];
    return record ? toMarketplaceListing(record.get("m")) : null;
  });
}
