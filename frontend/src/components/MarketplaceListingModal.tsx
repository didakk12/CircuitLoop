import { AlertTriangle, CheckCircle2, ExternalLink, Lock, X } from "lucide-react";
import { useState } from "react";

import { ApiError, publishMarketplaceListing, updateMarketplaceListing } from "../api";
import type { ApiMarketplaceListing } from "../api";

/**
 * Preview / edit / publish UI for one marketplace listing.
 *
 * Styles are inline rather than in `index.css` on purpose: this feature's
 * frontend footprint is meant to be `api.ts`, one additive button in
 * `Analysis.tsx`, and this file. Adding a block to the shared stylesheet would
 * put the feature's styling somewhere a reader of this component can't see it,
 * for no benefit at this size. Colours are taken from the palette the analysis
 * screen already uses.
 */

const PANEL_BG = "#0f1512";
const BORDER = "rgba(255, 255, 255, 0.09)";
const TEXT = "#dbe8df";
const MUTED = "#8fa397";
const ACCENT = "#8df2a8";

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.65)",
  display: "grid",
  placeItems: "center",
  padding: "24px",
  zIndex: 50,
};

const panelStyle: React.CSSProperties = {
  width: "min(560px, 100%)",
  maxHeight: "88vh",
  overflowY: "auto",
  background: PANEL_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: "14px",
  padding: "22px",
  color: TEXT,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  marginTop: "6px",
  padding: "9px 11px",
  borderRadius: "8px",
  border: `1px solid ${BORDER}`,
  background: "rgba(255, 255, 255, 0.03)",
  color: TEXT,
  font: "inherit",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginTop: "14px",
  fontSize: "11px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: MUTED,
};

function buttonStyle(variant: "primary" | "ghost", disabled: boolean): React.CSSProperties {
  return {
    padding: "9px 15px",
    borderRadius: "9px",
    border: variant === "primary" ? "1px solid transparent" : `1px solid ${BORDER}`,
    background: variant === "primary" ? "rgba(34, 197, 94, 0.16)" : "transparent",
    color: variant === "primary" ? ACCENT : TEXT,
    font: "inherit",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

/** Human-readable, honest one-liner per status — `ready_for_manual_post` must never read as "posted". */
const STATUS_TEXT: Record<ApiMarketplaceListing["status"], string> = {
  draft: "Draft — not posted anywhere yet.",
  ready_for_manual_post: "Ready to post — open the link below to finish on Facebook.",
  published: "Published — this listing is live and can no longer be edited.",
  failed: "Publishing failed. You can edit and try again.",
};

export interface MarketplaceListingModalProps {
  listing: ApiMarketplaceListing;
  onClose: () => void;
  /** Called whenever the listing changes server-side, so a parent can keep its own copy current. */
  onListingChange?: (listing: ApiMarketplaceListing) => void;
}

function MarketplaceListingModal({ listing, onClose, onListingChange }: MarketplaceListingModalProps) {
  const [current, setCurrent] = useState<ApiMarketplaceListing>(listing);
  const [title, setTitle] = useState(listing.title);
  const [description, setDescription] = useState(listing.description);
  const [category, setCategory] = useState(listing.category);
  const [price, setPrice] = useState(String(listing.price_estimate));
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The single source of truth for whether this listing is frozen. Only a
  // genuinely published listing is: `ready_for_manual_post` means nothing was
  // actually posted, so there is no live listing for an edit to contradict.
  const isPublished = current.status === "published";

  const apply = (updated: ApiMarketplaceListing): void => {
    setCurrent(updated);
    setTitle(updated.title);
    setDescription(updated.description);
    setCategory(updated.category);
    setPrice(String(updated.price_estimate));
    onListingChange?.(updated);
  };

  const describe = (err: unknown, fallback: string): string =>
    err instanceof ApiError ? err.message : fallback;

  const handleSave = async (): Promise<void> => {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const parsedPrice = Number(price);
      if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
        setError("Enter a price of 0 or more.");
        return;
      }
      const updated = await updateMarketplaceListing(current.id, {
        title,
        description,
        category,
        price_estimate: parsedPrice,
      });
      apply(updated);
      setNotice("Changes saved.");
    } catch (err) {
      // A 409 here means the listing was published while this form was open —
      // re-read so the UI stops offering edits it can no longer make.
      setError(describe(err, "Could not save the listing."));
      if (err instanceof ApiError && err.status === 409) {
        setCurrent({ ...current, status: "published" });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async (): Promise<void> => {
    setIsPublishing(true);
    setError(null);
    setNotice(null);
    try {
      // Resolves even when the provider failed — the backend records that as
      // `status: "failed"` and still answers 200, so the outcome is read off
      // the returned listing rather than from a thrown error.
      const published = await publishMarketplaceListing(current.id);
      apply(published);
      if (published.status === "failed") {
        setError(published.error_message ?? "Publishing failed.");
      } else {
        setNotice(STATUS_TEXT[published.status]);
      }
    } catch (err) {
      setError(describe(err, "Could not reach the server to publish."));
    } finally {
      setIsPublishing(false);
    }
  };

  const busy = isSaving || isPublishing;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Marketplace listing">
      <div style={panelStyle}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
          <div>
            <p style={{ margin: 0, fontSize: "11px", letterSpacing: "0.08em", color: MUTED }}>
              MARKETPLACE LISTING
            </p>
            <h4 style={{ margin: "4px 0 0" }}>{current.title}</h4>
          </div>

          <button type="button" onClick={onClose} style={buttonStyle("ghost", false)} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <p style={{ marginTop: "12px", color: isPublished ? ACCENT : MUTED, fontSize: "13px" }}>
          {isPublished && <Lock size={13} style={{ verticalAlign: "-2px", marginRight: "6px" }} />}
          {STATUS_TEXT[current.status]}
        </p>

        {current.image_url && (
          <img
            src={current.image_url}
            alt="Scan this listing was generated from"
            style={{
              width: "100%",
              maxHeight: "200px",
              objectFit: "cover",
              borderRadius: "10px",
              marginTop: "10px",
            }}
          />
        )}

        <label style={labelStyle}>
          Title
          <input
            style={fieldStyle}
            value={title}
            disabled={isPublished || busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Description
          <textarea
            style={{ ...fieldStyle, minHeight: "120px", resize: "vertical" }}
            value={description}
            disabled={isPublished || busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Category
          <input
            style={fieldStyle}
            value={category}
            disabled={isPublished || busy}
            onChange={(event) => setCategory(event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Price ({current.currency}) — estimate only, not an appraisal
          <input
            style={fieldStyle}
            type="number"
            min="0"
            step="0.01"
            value={price}
            disabled={isPublished || busy}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>

        {error && (
          <p style={{ marginTop: "14px", color: "#ffb4a8", fontSize: "13px" }}>
            <AlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: "6px" }} />
            {error}
          </p>
        )}

        {notice && !error && (
          <p style={{ marginTop: "14px", color: ACCENT, fontSize: "13px" }}>
            <CheckCircle2 size={13} style={{ verticalAlign: "-2px", marginRight: "6px" }} />
            {notice}
          </p>
        )}

        {current.external_url && (
          <p style={{ marginTop: "14px", fontSize: "13px" }}>
            <a
              href={current.external_url}
              target="_blank"
              rel="noreferrer"
              style={{ color: ACCENT, display: "inline-flex", alignItems: "center", gap: "6px" }}
            >
              <ExternalLink size={13} />
              {isPublished ? "View the live listing" : "Open Facebook to finish posting"}
            </a>
          </p>
        )}

        <div style={{ display: "flex", gap: "10px", marginTop: "20px", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={buttonStyle("ghost", false)}>
            Close
          </button>

          {/* Both actions disappear once published — the listing is a record of
              what was posted, and offering buttons that can only 409 is worse
              than not offering them. */}
          {!isPublished && (
            <>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={busy}
                style={buttonStyle("ghost", busy)}
              >
                {isSaving ? "Saving..." : "Save changes"}
              </button>

              <button
                type="button"
                onClick={() => void handlePublish()}
                disabled={busy}
                style={buttonStyle("primary", busy)}
              >
                {isPublishing ? "Publishing..." : "Publish"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default MarketplaceListingModal;
