/**
 * Scan history — the user's previous scans with their stored images.
 *
 * Reuses the existing `listScans` endpoint rather than adding a new one; it
 * already returns exactly what a history entry needs (id, timestamp,
 * total_components) and is now scoped to the signed-in user by the backend.
 * Selecting a scan hands off to the existing Analysis page instead of
 * duplicating its rendering.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { History as HistoryIcon, ImageOff } from "lucide-react";

import * as api from "../api";
import type { ApiScan } from "../api";

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime())
    ? timestamp
    : parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function History() {
  const navigate = useNavigate();
  const [scans, setScans] = useState<ApiScan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api
      .getScans()
      .then((result) => {
        if (!cancelled) {
          setScans(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load your scan history.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function openScan(scan: ApiScan) {
    // Analysis reads the scan id from sessionStorage, matching how ScanPCB
    // hands off today. The image now comes from the server, so no blob URL is
    // stored — that is what made a refresh lose the image.
    sessionStorage.setItem("pcbScanId", scan.id);
    sessionStorage.removeItem("pcbImage");
    navigate("/analysis");
  }

  return (
    <main className="page-content">
      <div className="page-heading">
        <p className="eyebrow">SCAN HISTORY</p>
        <h3>Previous scans</h3>
        <p>Every board you have scanned, with its uploaded image.</p>
      </div>

      {error !== null && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      {scans !== null && scans.length === 0 && (
        <div className="empty-state">
          <HistoryIcon size={32} />
          <h4>No scans yet</h4>
          <p>Scan a PCB and it will appear here.</p>
        </div>
      )}

      {scans !== null && scans.length > 0 && (
        <div className="history-grid">
          {scans.map((scan) => (
            <button
              type="button"
              key={scan.id}
              className="history-card"
              onClick={() => openScan(scan)}
            >
              <div className="history-thumb">
                {scan.image_url === null ? (
                  <div className="history-thumb-empty">
                    <ImageOff size={20} />
                    <span>No image</span>
                  </div>
                ) : (
                  <img src={scan.image_url} alt={`Scan from ${formatTimestamp(scan.timestamp)}`} />
                )}
              </div>

              <div className="history-meta">
                <strong>{formatTimestamp(scan.timestamp)}</strong>
                <span>
                  {scan.total_components}{" "}
                  {scan.total_components === 1 ? "component" : "components"}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

export default History;
