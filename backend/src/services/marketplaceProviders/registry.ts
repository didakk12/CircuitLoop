/**
 * Provider lookup, as a `Map` rather than a `switch`.
 *
 * The distinction matters: with a `switch`, every new marketplace edits the
 * service layer, and the list of supported providers is spread across whichever
 * functions happen to branch on it. With a map, the service asks for a provider
 * by name and never learns what implementations exist — so adding
 * `EbayProvider` is exactly one new class plus one `register(...)` line below,
 * and touches nothing else.
 *
 * The map is populated once at module load. `registerMarketplaceProvider` is
 * exported so tests can install a fake provider (a never-resolving one for the
 * timeout test, a throwing one for the failure test) against the same code path
 * production uses, with no Meta credentials and no network.
 */

import { settings } from "../../config/env.js";
import { UpstreamServiceError } from "../../utils/errors.js";
import { FacebookGraphProvider } from "./FacebookGraphProvider.js";
import { ManualAssistProvider } from "./ManualAssistProvider.js";
import type { MarketplaceProvider } from "./MarketplaceProvider.js";

const registry = new Map<string, MarketplaceProvider>();

/**
 * Adds (or replaces) a provider under its own `name`.
 *
 * Replacement is allowed rather than rejected so a test can swap in a fake for
 * a real provider name and restore it afterwards; production only ever calls
 * this at module load, below.
 */
export function registerMarketplaceProvider(provider: MarketplaceProvider): void {
  registry.set(provider.name, provider);
}

/** Removes a provider. Exists for test cleanup; nothing in production calls it. */
export function unregisterMarketplaceProvider(name: string): void {
  registry.delete(name);
}

/** Every registered provider name — used by the error message below and by tests. */
export function marketplaceProviderNames(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Looks up the configured provider (or an explicitly named one).
 *
 * Throws `UpstreamServiceError` for an unknown name — a misconfiguration, not a
 * caller error. It surfaces through `publishDraft`'s catch like any other
 * provider failure, so a typo'd `CIRCUITLOOP_MARKETPLACE_PROVIDER` produces a
 * listing marked `failed` with a message naming the valid options, rather than
 * a 500 or a silently-skipped publish.
 */
export function getMarketplaceProvider(name: string = settings.marketplaceProvider): MarketplaceProvider {
  const provider = registry.get(name);
  if (!provider) {
    throw new UpstreamServiceError(
      503,
      `Unknown marketplace provider '${name}'. Registered providers: ${marketplaceProviderNames().join(", ")}. ` +
        "Check CIRCUITLOOP_MARKETPLACE_PROVIDER.",
    );
  }
  return provider;
}

registerMarketplaceProvider(new ManualAssistProvider());
registerMarketplaceProvider(new FacebookGraphProvider());
