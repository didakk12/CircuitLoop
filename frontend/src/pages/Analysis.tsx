import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ScanLine,
  Tag,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, componentIdentity, createMarketplaceDraft, getScan } from "../api";
import type { ApiComponent, ApiMarketplaceListing, ApiScan } from "../api";
import MarketplaceListingModal from "../components/MarketplaceListingModal";

interface NaturalSize {
  width: number;
  height: number;
}

function Analysis() {
  const navigate = useNavigate();

  // Read once per mount — sessionStorage is an external, synchronous
  // source, so these don't belong in an effect (and nothing else writes to
  // these keys during this component's lifetime).
  // The blob URL from the just-completed upload, when arriving straight from
  // ScanPCB — it renders instantly with no round trip.
  const [localImageUrl] = useState<string | null>(() => sessionStorage.getItem("pcbImage"));
  const [scanId] = useState<string | null>(() => sessionStorage.getItem("pcbScanId"));

  const [scan, setScan] = useState<ApiScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(scanId !== null);
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);

  // --- Marketplace listing (additive) ---------------------------------------
  // Which component is awaiting a Yes/No confirm, the listing the modal is
  // showing, and any error from creating a draft. All three are null in the
  // default state, so this feature adds nothing to the page until clicked.
  const [confirmingComponentId, setConfirmingComponentId] = useState<string | null>(null);
  const [pendingComponentId, setPendingComponentId] = useState<string | null>(null);
  const [activeListing, setActiveListing] = useState<ApiMarketplaceListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);

  const startListing = (componentId: string): void => {
    setConfirmingComponentId(null);
    setPendingComponentId(componentId);
    setListingError(null);

    // Creates a draft, or reopens the component's existing active one — the
    // backend's duplicate-draft policy means clicking twice never spawns a
    // second listing or discards earlier edits.
    createMarketplaceDraft(componentId)
      .then(setActiveListing)
      .catch((err: unknown) => {
        setListingError(err instanceof ApiError ? err.message : "Could not prepare a marketplace listing.");
      })
      .finally(() => setPendingComponentId(null));
  };

  useEffect(() => {
    if (!scanId) {
      return;
    }

    getScan(scanId)
      .then(setScan)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not load the analysis results.");
      })
      .finally(() => setIsLoading(false));
  }, [scanId]);

  // A blob URL dies with the page, which is why a refresh used to lose the
  // image. The server copy is authoritative and survives reload, restart, and
  // revisiting from history; the blob is only a first-paint shortcut.
  const imageUrl = scan?.image_url ?? localImageUrl;

  if (!imageUrl && !isLoading) {
    return (
      <main className="page-content">
        <button
          className="back-button"
          onClick={() => navigate("/scan")}
        >
          <ArrowLeft size={17} />
          Back to scan
        </button>

        <div className="empty-state">
          <ScanLine size={32} />

          <h4>No PCB image found</h4>

          <p>
            Upload a PCB image before starting the analysis.
          </p>

          <button
            className="upload-button"
            onClick={() => navigate("/scan")}
            style={{ marginTop: "20px" }}
          >
            Upload PCB
          </button>
        </div>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="page-content">
        <div className="empty-state">
          <ScanLine size={32} />
          <h4>Analyzing...</h4>
          <p>Waiting for detection results.</p>
        </div>
      </main>
    );
  }

  if (error || !scan) {
    return (
      <main className="page-content">
        <button
          className="back-button"
          onClick={() => navigate("/scan")}
        >
          <ArrowLeft size={17} />
          Back to scan
        </button>

        <div className="empty-state empty-state-error">
          <AlertTriangle size={32} />
          <h4>Could not load results</h4>
          <p>{error ?? "Unknown error."}</p>
        </div>
      </main>
    );
  }

  const components = scan.components;

  return (
    <main className="page-content">
      <div className="analysis-header">
        <div>
          <p className="eyebrow">COMPUTER VISION ANALYSIS</p>

          <h3>PCB Analysis</h3>

          <p>
            Components detected by the CircuitLoop vision system.
          </p>
        </div>

        <div className="analysis-status">
          <CheckCircle2 size={17} />
          Analysis complete
        </div>
      </div>

      <section className="analysis-layout">
        <div className="pcb-viewer">
          <div className="pcb-viewer-header">
            <span>Scan {scan.id.slice(0, 8)}</span>
            <span>{components.length} detected</span>
          </div>

          <div className="pcb-image-container">
            <img
              src={imageUrl ?? undefined}
              alt="Uploaded PCB"
              className="pcb-image"
              onLoad={(event) =>
                setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />

            {naturalSize &&
              components.map((component, index) => {
                const marker = toMarkerStyle(component, naturalSize);
                if (!marker) {
                  return null;
                }

                return (
                  <div
                    key={component.id}
                    className="component-marker"
                    style={marker}
                  >
                    <span>{index + 1}</span>
                  </div>
                );
              })}
          </div>
        </div>

        <aside className="analysis-sidebar">
          <div className="analysis-sidebar-header">
            <div>
              <span className="eyebrow">DETECTED</span>
              <h4>Components</h4>
            </div>

            <span className="component-count">
              {components.length}
            </span>
          </div>

          <div className="analysis-component-list">
            {components.map((component, index) => (
              <div key={component.id}>
                <button
                  className="analysis-component"
                  onClick={() => navigate("/components")}
                >
                  <div className="analysis-component-id">
                    {index + 1}
                  </div>

                  <div className="analysis-component-info">
                    <strong>
                      {componentIdentity(component)}
                    </strong>

                    {component.name && (
                      <span className="component-marking" title={component.name}>
                        {component.name}
                      </span>
                    )}

                    <span>
                      {Math.round(component.confidence * 100)}%
                      identification
                    </span>
                  </div>

                  {component.salvage_priority && (
                    <span
                      className={`priority-dot priority-${component.salvage_priority}`}
                    />
                  )}
                </button>

                {/* Additive: offer to list this component for sale. Collapsed to
                    a single link until clicked, and "No" is a pure no-op that
                    contacts nothing — the draft is only created on "Yes". */}
                {confirmingComponentId === component.id ? (
                  <div style={marketplaceConfirmStyle}>
                    <span>List this component on Marketplace?</span>

                    <button
                      type="button"
                      style={marketplaceActionStyle}
                      disabled={pendingComponentId === component.id}
                      onClick={() => startListing(component.id)}
                    >
                      {pendingComponentId === component.id ? "Preparing..." : "Yes"}
                    </button>

                    <button
                      type="button"
                      style={marketplaceActionStyle}
                      onClick={() => setConfirmingComponentId(null)}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={marketplacePromptStyle}
                    onClick={() => setConfirmingComponentId(component.id)}
                  >
                    <Tag size={12} />
                    List on Marketplace?
                  </button>
                )}
              </div>
            ))}
          </div>
        </aside>
      </section>

      {listingError && (
        <p style={{ marginTop: "14px", color: "#ffb4a8", fontSize: "13px" }}>{listingError}</p>
      )}

      {activeListing && (
        <MarketplaceListingModal
          listing={activeListing}
          onListingChange={setActiveListing}
          onClose={() => setActiveListing(null)}
        />
      )}
    </main>
  );
}

// Inline styles for the additive marketplace affordance, kept local so this
// feature adds nothing to the shared stylesheet. Palette matches the
// surrounding analysis sidebar.
const marketplacePromptStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  margin: "0 0 6px 45px",
  padding: "4px 0",
  background: "transparent",
  border: "none",
  color: "#8fa397",
  fontSize: "12px",
  cursor: "pointer",
};

const marketplaceConfirmStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  margin: "0 0 6px 45px",
  color: "#dbe8df",
  fontSize: "12px",
};

const marketplaceActionStyle: React.CSSProperties = {
  padding: "3px 10px",
  borderRadius: "7px",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "transparent",
  color: "#8df2a8",
  font: "inherit",
  cursor: "pointer",
};

/** Backend bounding boxes are absolute pixel coordinates; the overlay needs percentages of the rendered image. */
function toMarkerStyle(
  component: ApiComponent,
  naturalSize: NaturalSize,
): { left: string; top: string; width: string; height: string } | null {
  const { x1, y1, x2, y2 } = component;

  if (x1 === null || y1 === null || x2 === null || y2 === null || naturalSize.width === 0 || naturalSize.height === 0) {
    return null;
  }

  return {
    left: `${(x1 / naturalSize.width) * 100}%`,
    top: `${(y1 / naturalSize.height) * 100}%`,
    width: `${((x2 - x1) / naturalSize.width) * 100}%`,
    height: `${((y2 - y1) / naturalSize.height) * 100}%`,
  };
}

export default Analysis;
