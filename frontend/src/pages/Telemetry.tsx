import {
Activity,
AlertTriangle,
Cpu,
MemoryStick,
RefreshCw,
Server,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiError, getTelemetry } from "../api";
import type { ApiTelemetryResponse } from "../api";

function Telemetry() {
const [telemetry, setTelemetry] = useState<ApiTelemetryResponse | null>(null);
const [error, setError] = useState<string | null>(null);
const [lastUpdated, setLastUpdated] = useState<string | null>(null);

const loadTelemetry = useCallback(async () => {
try {
const result = await getTelemetry();


  setTelemetry(result);
  setError(null);

  if (result) {
    setLastUpdated(new Date().toLocaleTimeString());
  }
} catch (err: unknown) {
  setError(
    err instanceof ApiError
      ? err.message
      : "Could not load telemetry.",
  );
}

}, []);

useEffect(() => {
void loadTelemetry();


const interval = window.setInterval(() => {
  void loadTelemetry();
}, 10000);

return () => {
  window.clearInterval(interval);
};


}, [loadTelemetry]);

const memory = telemetry?.telemetry.system_metrics.memory;
const processes = telemetry?.telemetry.top_processes ?? [];
const response = telemetry?.response;

return ( <main className="page-content"> <div className="page-heading"> <p className="eyebrow">SYSTEM MONITORING</p>


    <h3>Telemetry</h3>

    <p>
      Monitor system health and automated remediation decisions
      received from the CircuitLoop telemetry agent.
    </p>
  </div>

  {!telemetry && !error && (
    <div className="empty-state">
      <Server size={32} />
      <h4>Waiting for telemetry</h4>
      <p>
        Start the CircuitLoop Windows telemetry agent to begin
        receiving system information.
      </p>
    </div>
  )}

  {error && (
    <section className="info-panel info-panel-error">
      <AlertTriangle size={20} />

      <div>
        <strong>Could not load telemetry</strong>
        <p>{error}</p>
      </div>
    </section>
  )}

  {telemetry && (
    <>
      <div className="test-status">
        <div className="test-status-icon">
          <Activity size={22} />
        </div>

        <div>
          <strong>{telemetry.telemetry.agent_id}</strong>

          <span>
            Last telemetry received{" "}
            {lastUpdated ?? "just now"}
          </span>
        </div>

        <span
          className={`connection-badge ${
            response?.status === "NORMAL"
              ? ""
              : "connection-badge-alert"
          }`}
        >
          {response?.status === "NORMAL"
            ? "Healthy"
            : "Action Required"}
        </span>
      </div>

      <section className="info-panel">
        <MemoryStick size={20} />

        <div>
          <strong>Memory Usage</strong>

          <p>
            {memory?.used_mb.toFixed(2)} MB used of{" "}
            {memory?.total_gb.toFixed(2)} GB total (
            {memory?.used_percent.toFixed(2)}%)
          </p>

          <p>
            Free memory: {memory?.free_mb.toFixed(2)} MB
          </p>

          <p>
            Hard faults/sec:{" "}
            {memory?.hard_faults_per_sec.toFixed(2)}
          </p>
        </div>
      </section>

      {response?.status === "ACTION_REQUIRED" && (
        <section className="info-panel info-panel-error">
          <AlertTriangle size={20} />

          <div>
            <strong>Action Required</strong>

            <p>
              Requested action:{" "}
              <strong>{response.action_id}</strong>
            </p>

            {response.target_pid !== undefined && (
              <p>
                Target PID:{" "}
                <strong>{response.target_pid}</strong>
              </p>
            )}

            <p>
              The Windows telemetry agent will handle the
              requested remediation according to its safety
              rules.
            </p>
          </div>
        </section>
      )}

      <div className="page-heading">
        <p className="eyebrow">PROCESS MONITORING</p>

        <h3>Top Processes</h3>

        <p>
          Processes reported by the Windows telemetry agent,
          ordered by memory usage.
        </p>
      </div>

      <div className="component-grid">
        {processes.map((process) => (
          <div className="component-card" key={process.pid}>
            <div className="component-card-top">
              <div className="component-icon">
                <Cpu size={20} />
              </div>
            </div>

            <h4>{process.name}</h4>

            <p className="component-type">
              PID {process.pid}
            </p>

            <div className="component-confidence">
              <span>Working Set</span>

              <strong>
                {process.working_set_mb.toFixed(2)} MB
              </strong>
            </div>

            <div className="component-confidence">
              <span>Commit</span>

              <strong>
                {process.commit_mb.toFixed(2)} MB
              </strong>
            </div>
          </div>
        ))}
      </div>

      <section className="info-panel">
        <RefreshCw size={20} />

        <div>
          <strong>Automatic monitoring</strong>

          <p>
            Telemetry is refreshed automatically every 10
            seconds while this page is open.
          </p>
        </div>
      </section>
    </>
  )}
</main>

);
}

export default Telemetry;
