/**
 * Marketplace listing lifecycle: generate a draft from a detected component,
 * let the user edit it, hand it to a provider, and record what happened.
 *
 * Two rules shape almost everything below.
 *
 * 1. **Publishing never fails the request.** A provider that throws, hangs, or
 *    isn't configured produces a listing in `status: "failed"` carrying the
 *    reason, and the endpoint still answers 200 — the same degrade-gracefully
 *    posture `assistantService` takes with its LLM providers. The user's draft
 *    is never lost to an upstream outage, and the frontend has one shape to
 *    render instead of a success path plus a 5xx path.
 * 2. **This module reads the component pipeline and never writes to it.** The
 *    only call into it is the existing, unmodified
 *    `componentService.getComponentById`, which doubles as the ownership check:
 *    it throws `NotFoundError` for a component the caller doesn't own, so a
 *    foreign component id is indistinguishable from a missing one.
 */

import { settings } from "../config/env.js";
import type { QueryRunner } from "../db/session.js";
import * as marketplaceRepository from "../repositories/marketplaceRepository.js";
import type {
  ComponentCondition,
  ComponentDetail,
  ComponentType,
  MarketplaceListing,
} from "../types/entities.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import * as componentService from "./componentService.js";
import type { MarketplaceDraft } from "./marketplaceProviders/MarketplaceProvider.js";
import { getMarketplaceProvider } from "./marketplaceProviders/registry.js";
import { DEFAULT_CURRENCY, estimatePrice } from "./pricingHeuristic.js";

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * One log line per marketplace event, in the stable payload shape the feature
 * plan specifies.
 *
 * The `[ISO] [LEVEL] ...` prefix matches the existing `log()` helpers in
 * `index.ts` and `middleware/errorHandler.ts` exactly. Those are module-private
 * (exporting either would drag the Express app or the error middleware into
 * every importer), so the format is matched rather than the function imported —
 * and no general-purpose logger is introduced, since that would be a refactor
 * outside this feature's scope.
 */
interface MarketplaceLogPayload {
  event: string;
  entityType: "marketplace_listing";
  entityId?: string;
  state?: string;
  error?: string;
  timestamp: string;
}

function logMarketplaceEvent(
  level: "INFO" | "WARN",
  payload: Omit<MarketplaceLogPayload, "entityType" | "timestamp">,
): void {
  const line: MarketplaceLogPayload = {
    ...payload,
    entityType: "marketplace_listing",
    timestamp: new Date().toISOString(),
  };
  console.log(`[${line.timestamp}] [${level}] ${JSON.stringify(line)}`);
}

// ---------------------------------------------------------------------------
// Draft generation (pure)
// ---------------------------------------------------------------------------

/**
 * What the component IS, for the listing title — the server-side mirror of the
 * frontend's `componentIdentity()` in `frontend/src/api.ts`, deliberately
 * identical rule for identical reasons.
 *
 * The printed marking (`Component.name` — "74HC83", "CISCO SG300-52 …") is
 * evidence about the part, not its identity, and must never become the title: a
 * listing headed "CISCO SG300-52" advertises a brand string read by OCR rather
 * than the thing being sold. The marking appears in the description instead.
 */
export function listingIdentity(component: Pick<ComponentDetail, "label" | "type">): string {
  const label = component.label?.trim();
  return label && label.length > 0 ? label : component.type;
}

/** Capitalises each word for display — "network switch" → "Network Switch". */
function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The listing headline. Derived only from the component's identity — never from the OCR marking. */
export function buildListingTitle(component: Pick<ComponentDetail, "label" | "type">): string {
  return titleCase(listingIdentity(component));
}

/**
 * Marketplace category per component type.
 *
 * A total `Record` rather than a lookup with a default, so extending the
 * `ComponentType` union fails compilation here instead of silently filing a new
 * type under "Other".
 */
const CATEGORY_BY_TYPE: Record<ComponentType, string> = {
  resistor: "Electronics > Components > Passive Components",
  capacitor: "Electronics > Components > Passive Components",
  led: "Electronics > Components > Optoelectronics",
  diode: "Electronics > Components > Semiconductors",
  transistor: "Electronics > Components > Semiconductors",
  ic: "Electronics > Components > Integrated Circuits",
  microcontroller: "Electronics > Components > Microcontrollers & Dev Boards",
  battery: "Electronics > Components > Batteries & Power",
  buzzer: "Electronics > Components > Audio & Buzzers",
  display: "Electronics > Components > Displays",
  relay: "Electronics > Components > Relays & Switching",
  switch: "Electronics > Components > Relays & Switching",
  unknown: "Electronics > Components > Other",
};

export function categoryForType(type: ComponentType): string {
  return CATEGORY_BY_TYPE[type];
}

/**
 * Honest one-line summary of what is known about the part's condition.
 *
 * `uncertain` and `unknown` say plainly that it has not been verified rather
 * than implying it works — the detector inspected a photo, which is not a test,
 * and a buyer reading this listing deserves to know that.
 */
const CONDITION_CAVEAT: Record<ComponentCondition, string> = {
  good: "Condition: appears intact on visual inspection. Not electrically tested.",
  damaged: "Condition: visible damage. Sold as-is, for parts or repair only.",
  uncertain: "Condition: could not be determined confidently from the photo. Sold untested, as-is.",
  unknown: "Condition: not assessed. Sold untested, as-is.",
};

/**
 * The templated listing body.
 *
 * Every claim in it is traceable to a stored field, and the two things the
 * system does *not* know — whether the part works, and what it is worth — are
 * stated as unknowns rather than papered over.
 */
export function buildListingDescription(component: ComponentDetail): string {
  const identity = titleCase(listingIdentity(component));
  const marking = component.name?.trim();

  const lines: string[] = [
    `Salvaged ${identity.toLowerCase()} recovered from a circuit board.`,
    "",
    `Type: ${component.type}`,
  ];

  // Only present when the part actually carries printed text. Labelled as a
  // marking so it is never mistaken for the item's identity or a guarantee of
  // the exact part number.
  if (marking && marking.length > 0) {
    lines.push(`Marking on part: ${marking}`);
  }

  lines.push(
    CONDITION_CAVEAT[component.condition],
    "",
    "Price is an automatic estimate only — not an appraisal or a quote. Offers welcome.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Listing operations
// ---------------------------------------------------------------------------

/**
 * Result of `createDraft`, which is either a genuinely new listing or the
 * component's existing active one.
 *
 * The controller needs the distinction for its status code (201 vs 200) and
 * nothing else does, so it rides along here rather than being re-derived from
 * timestamps.
 */
export interface CreateDraftResult {
  listing: MarketplaceListing;
  /** False when an existing active listing was returned instead of a new one. */
  created: boolean;
}

/**
 * Creates a draft for a component — or hands back the one it already has.
 *
 * The duplicate-draft policy: a component may accumulate any number of
 * *historical* listings, but only one **active** one (`draft`,
 * `ready_for_manual_post`, or `failed`) at a time. Clicking "List on
 * Marketplace" twice therefore reopens the same draft with the user's edits
 * intact instead of silently spawning a second one. Once a listing reaches
 * `published` it is no longer active, so re-listing the component creates a
 * fresh draft — which is what selling a second unit, or relisting after a sale,
 * actually needs.
 */
export async function createDraft(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<CreateDraftResult> {
  // Throws NotFoundError for a component that is missing *or* someone else's.
  const component = await componentService.getComponentById(componentId, ownerId, runner);

  const existing = await marketplaceRepository.findActiveListingForComponent(componentId, ownerId, runner);
  if (existing) {
    logMarketplaceEvent("INFO", {
      event: "draft_reused",
      entityId: existing.id,
      state: existing.status,
    });
    return { listing: existing, created: false };
  }

  const listing = await marketplaceRepository.createListing(
    {
      componentId,
      // Read once, here, and stored on the listing — see entities.ts on why the
      // image URL must not be re-derived by traversal on every read.
      scanId: component.scanId,
      provider: settings.marketplaceProvider,
      title: buildListingTitle(component),
      description: buildListingDescription(component),
      category: categoryForType(component.type),
      priceEstimate: estimatePrice(component.type, component.condition),
      currency: DEFAULT_CURRENCY,
    },
    ownerId,
    runner,
  );

  // Only reachable if the component vanished between the two statements above.
  if (!listing) {
    throw new NotFoundError("Component", componentId);
  }

  logMarketplaceEvent("INFO", { event: "draft_created", entityId: listing.id, state: listing.status });
  return { listing, created: true };
}

export async function getListing(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing> {
  const listing = await marketplaceRepository.getListingById(id, ownerId, runner);
  if (!listing) {
    throw new NotFoundError("Marketplace listing", id);
  }
  return listing;
}

/**
 * A component's full listing history, oldest-first.
 *
 * Ownership is enforced by the repository query itself; a component that isn't
 * the caller's reads back as `null` and becomes a 404 rather than an empty
 * array, so the response can't be used to probe for other users' component ids.
 */
export async function listListingsForComponent(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing[]> {
  const listings = await marketplaceRepository.listListingsForComponent(componentId, ownerId, runner);
  if (listings === null) {
    throw new NotFoundError("Component", componentId);
  }
  return listings;
}

/** The editable fields. Every one optional — a PATCH may change just the price. */
export interface UpdateDraftInput {
  title?: string;
  description?: string;
  category?: string;
  priceEstimate?: number;
  currency?: string;
}

/**
 * Edits a listing that has not been published.
 *
 * Once `status` is `published` the content is frozen: the listing is a record
 * of what was actually posted, and letting it drift from that would make it
 * describe an item nobody advertised. That case is a `409 ConflictError`, not a
 * silent no-op, so the frontend can say why the fields are disabled.
 *
 * `ready_for_manual_post` stays editable on purpose — the manual-assist
 * provider posts nothing, so there is no live listing to contradict.
 */
export async function updateDraft(
  id: string,
  input: UpdateDraftInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing> {
  const existing = await getListing(id, ownerId, runner);

  if (existing.status === "published") {
    throw new ConflictError(
      `Marketplace listing ${id} has been published and can no longer be edited. ` +
        "Create a new listing for this component instead.",
    );
  }

  const updated = await marketplaceRepository.updateListingContent(
    id,
    {
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      category: input.category ?? existing.category,
      priceEstimate: input.priceEstimate ?? existing.priceEstimate,
      currency: input.currency ?? existing.currency,
    },
    ownerId,
    runner,
  );

  // The read above already proved the listing exists and is the caller's, so a
  // null here means the repository's own `status <> "published"` guard rejected
  // the write — i.e. a publish landed between the two statements. Same answer
  // as if the read had seen it.
  if (!updated) {
    throw new ConflictError(
      `Marketplace listing ${id} was published while this edit was in flight and can no longer be edited.`,
    );
  }

  logMarketplaceEvent("INFO", { event: "draft_updated", entityId: updated.id, state: updated.status });
  return updated;
}

/**
 * Races `work` against a timer.
 *
 * A provider that never settles must not hold an HTTP request open forever, and
 * `Promise.race` is enough because the loser is simply abandoned: the timer is
 * always cleared (so a fast provider leaves nothing keeping the process alive),
 * and a hung provider promise stays pending harmlessly with no one awaiting it.
 * `AbortController` isn't used because `MarketplaceProvider.publish` takes no
 * signal — a provider that wants real cancellation can accept one when that is
 * added to the interface.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The immutable snapshot handed to the provider — never the live entity. */
function toProviderDraft(listing: MarketplaceListing): MarketplaceDraft {
  return {
    id: listing.id,
    componentId: listing.componentId,
    // Same URL the DTO exposes, built from the scanId captured at creation.
    imageUrl: listing.scanId === null ? null : `/api/scans/${listing.scanId}/image`,
    title: listing.title,
    description: listing.description,
    category: listing.category,
    priceEstimate: listing.priceEstimate,
    currency: listing.currency,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hands the listing to its provider and records the outcome.
 *
 * Never throws for a provider problem. An unregistered provider name, a
 * provider that rejects, and a provider that hangs past
 * `marketplacePublishTimeoutMs` all land in the same place: `status: "failed"`
 * with `errorMessage` set, returned as a normal 200. The only errors that
 * escape are `NotFoundError` for a listing that isn't the caller's — an
 * authorization answer, not an upstream one.
 */
export async function publishDraft(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<MarketplaceListing> {
  const listing = await getListing(id, ownerId, runner);

  // Idempotent by design: re-publishing something already live would post a
  // second copy upstream and overwrite the external ids recording the first,
  // which is precisely what published-immutability exists to prevent. Answering
  // with the existing listing is the honest no-op — and it is not a 409, which
  // the contract reserves for editing a published listing.
  if (listing.status === "published") {
    logMarketplaceEvent("INFO", {
      event: "publish_skipped_already_published",
      entityId: listing.id,
      state: listing.status,
    });
    return listing;
  }

  logMarketplaceEvent("INFO", { event: "publish_requested", entityId: listing.id, state: listing.provider });

  let outcome: marketplaceRepository.MarketplacePublishOutcome;
  try {
    // Inside the try on purpose: an unknown provider name is a configuration
    // failure that should surface on the listing like any other publish
    // failure, not as a 503 that loses the draft.
    const provider = getMarketplaceProvider(listing.provider);
    const result = await withTimeout(
      provider.publish(toProviderDraft(listing)),
      settings.marketplacePublishTimeoutMs,
      `Publishing timed out after ${settings.marketplacePublishTimeoutMs}ms`,
    );
    outcome = {
      status: result.status,
      externalUrl: result.externalUrl,
      externalListingId: result.externalListingId,
      errorMessage: null,
    };
  } catch (error) {
    // The provider name is included because "which marketplace failed" is the
    // first thing anyone reading this asks. The message comes from the
    // provider's own error, which by convention never carries a credential.
    const message = describeError(error);
    logMarketplaceEvent("WARN", {
      event: "publish_failed",
      entityId: listing.id,
      state: listing.provider,
      error: message,
    });
    outcome = {
      status: "failed",
      // Cleared rather than preserved: a leftover link next to a failed status
      // reads as "it partly worked", and nothing was posted.
      externalUrl: null,
      externalListingId: null,
      errorMessage: `${listing.provider}: ${message}`,
    };
  }

  const updated = await marketplaceRepository.applyPublishOutcome(id, outcome, ownerId, runner);
  if (!updated) {
    throw new NotFoundError("Marketplace listing", id);
  }

  if (outcome.status !== "failed") {
    logMarketplaceEvent("INFO", {
      event: "publish_succeeded",
      entityId: updated.id,
      state: updated.status,
    });
  }

  return updated;
}
