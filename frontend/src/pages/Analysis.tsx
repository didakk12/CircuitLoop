import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ScanLine,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, getScan } from "../api";
import type { ApiComponent, ApiScan } from "../api";

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
              <button
                key={component.id}
                className="analysis-component"
                onClick={() => navigate("/components")}
              >
                <div className="analysis-component-id">
                  {index + 1}
                </div>

                <div className="analysis-component-info">
                  <strong>
                    {component.name || component.type}
                  </strong>

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
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

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
