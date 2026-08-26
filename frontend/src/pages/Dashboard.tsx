import {
  Activity,
  ScanLine,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { getDashboardStats } from "../api";
import type { DashboardStats } from "../api";

function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashboardStats()
      .then(setStats)
      .catch((requestError: Error) => setError(requestError.message));
  }, []);

  return (
    <main className="page-content">
      <section className="hero">
        <div className="hero-content">
          <div className="hero-icon">
            <Activity size={28} />
          </div>

          <p className="eyebrow">AI-POWERED PCB ANALYSIS</p>

          <h3>
            Turn discarded electronics
            <br />
            into <span>reusable components.</span>
          </h3>

          <p className="hero-description">
            Upload a PCB image and let CircuitLoop identify components,
            retrieve technical information, and evaluate their salvage
            potential.
          </p>

          <button
            className="upload-button"
            onClick={() => navigate("/scan")}
          >
            <Upload size={19} />
            Upload PCB Image
          </button>
        </div>

        <div className="hero-decoration">
          <div className="circuit-node node-one" />
          <div className="circuit-node node-two" />
          <div className="circuit-node node-three" />
          <div className="circuit-line line-one" />
          <div className="circuit-line line-two" />
          <div className="circuit-line line-three" />
        </div>
      </section>

      <section className="stats-grid">
        <div className="stat-card">
          <span>PCBs scanned</span>
          <strong>{stats?.total_scans ?? "-"}</strong>
          <small>{error ?? "Connected to backend"}</small>
        </div>

        <div className="stat-card">
          <span>Components identified</span>
          <strong>{stats?.total_components ?? "-"}</strong>
          <small>AI detection results</small>
        </div>

        <div className="stat-card">
          <span>Components tested</span>
          <strong>{stats?.tested_components ?? "-"}</strong>
          <small>Hardware verification</small>
        </div>

        <div className="stat-card">
          <span>Potentially salvageable</span>
          <strong>{stats?.passed_components ?? "-"}</strong>
          <small>Passed component tests</small>
        </div>
      </section>

      <section className="quick-actions">
        <div>
          <p className="eyebrow">QUICK ACTIONS</p>
          <h3>What would you like to do?</h3>
        </div>

        <div className="quick-action-grid">
          <button
            className="quick-action-card"
            onClick={() => navigate("/scan")}
          >
            <ScanLine size={24} />
            <strong>Scan a PCB</strong>
            <span>Upload an image for AI analysis.</span>
          </button>

          <button
            className="quick-action-card"
            onClick={() => navigate("/components")}
          >
            <Activity size={24} />
            <strong>View components</strong>
            <span>Explore identified components.</span>
          </button>
        </div>
      </section>
    </main>
  );
}

export default Dashboard;