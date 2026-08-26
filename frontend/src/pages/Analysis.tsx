import {
  ArrowLeft,
  CheckCircle2,
  ScanLine,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { mockScan } from "../data/mockScan";

function Analysis() {
  const navigate = useNavigate();

  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const storedImage = sessionStorage.getItem("pcbImage");

    if (storedImage) {
      setImageUrl(storedImage);
    }
  }, []);

  if (!imageUrl) {
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
            <span>PCB-001</span>
            <span>{mockScan.components.length} detected</span>
          </div>

          <div className="pcb-image-container">
            <img
              src={imageUrl}
              alt="Uploaded PCB"
              className="pcb-image"
            />

            {mockScan.components.map((component) => (
              <div
                key={component.id}
                className="component-marker"
                style={{
                  left: `${component.boundingBox.x}%`,
                  top: `${component.boundingBox.y}%`,
                  width: `${component.boundingBox.width}%`,
                  height: `${component.boundingBox.height}%`,
                }}
              >
                <span>{component.id}</span>
              </div>
            ))}
          </div>
        </div>

        <aside className="analysis-sidebar">
          <div className="analysis-sidebar-header">
            <div>
              <span className="eyebrow">DETECTED</span>
              <h4>Components</h4>
            </div>

            <span className="component-count">
              {mockScan.components.length}
            </span>
          </div>

          <div className="analysis-component-list">
            {mockScan.components.map((component) => (
              <button
                key={component.id}
                className="analysis-component"
                onClick={() => navigate("/components")}
              >
                <div className="analysis-component-id">
                  {component.id}
                </div>

                <div className="analysis-component-info">
                  <strong>
                    {component.value || component.type}
                  </strong>

                  <span>
                    {Math.round(component.confidence * 100)}%
                    identification
                  </span>
                </div>

                <span
                  className={`priority-dot priority-${component.salvagePriority}`}
                />
              </button>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

export default Analysis;