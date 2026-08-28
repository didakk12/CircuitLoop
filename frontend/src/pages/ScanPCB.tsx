import { AlertTriangle, ArrowLeft, ScanLine } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, createScan, uploadAndDetect } from "../api";
import ImageUploader from "../components/ImageUploader";

function ScanPCB() {
  const navigate = useNavigate();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async (file: File, imageUrl: string) => {
    setIsAnalyzing(true);
    setError(null);

    try {
      const scan = await createScan();
      await uploadAndDetect(scan.id, file);

      sessionStorage.setItem("pcbImage", imageUrl);
      sessionStorage.setItem("pcbScanId", scan.id);

      navigate("/analysis");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong while analyzing the image.");
      setIsAnalyzing(false);
    }
  };

  return (
    <main className="page-content">
      <button
        className="back-button"
        onClick={() => navigate("/")}
      >
        <ArrowLeft size={17} />
        Back to dashboard
      </button>

      <div className="page-heading">
        <p className="eyebrow">PCB ANALYSIS</p>

        <h3>Scan a PCB</h3>

        <p>
          Upload a clear image of the PCB to begin component
          detection and analysis.
        </p>
      </div>

      <ImageUploader onAnalyze={handleAnalyze} isAnalyzing={isAnalyzing} />

      {error && (
        <section className="info-panel info-panel-error">
          <AlertTriangle size={20} />

          <div>
            <strong>Analysis failed</strong>
            <p>{error}</p>
          </div>
        </section>
      )}

      <section className="info-panel">
        <ScanLine size={20} />

        <div>
          <strong>What happens next?</strong>

          <p>
            CircuitLoop will detect visible components, identify
            their markings, and estimate their salvage priority.
          </p>
        </div>
      </section>
    </main>
  );
}

export default ScanPCB;
