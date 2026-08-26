import { ArrowLeft, ScanLine } from "lucide-react";
import { useNavigate } from "react-router-dom";

import ImageUploader from "../components/ImageUploader";

function ScanPCB() {
  const navigate = useNavigate();

  const handleAnalyze = (imageUrl: string) => {
    sessionStorage.setItem("pcbImage", imageUrl);

    navigate("/analysis");
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

      <ImageUploader onAnalyze={handleAnalyze} />

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