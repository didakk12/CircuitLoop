import { Activity, AlertTriangle, TestTube, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, getComponents, getLatestTestResult } from "../api";
import type { ApiComponent, ApiTestResult } from "../api";

interface TestedComponent {
  component: ApiComponent;
  result: ApiTestResult;
}

function Testing() {
  const [testedComponents, setTestedComponents] = useState<TestedComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getComponents()
      .then(async (components) => {
        // GET /api/components (list) doesn't include nested test_results
        // (see backend/src/repositories/componentRepository.ts — list is a
        // summary, get-by-id/test-result is where full detail lives), so
        // the latest result is fetched per component using the existing
        // GET /api/components/:id/test-result endpoint. No new backend
        // endpoint was added for this — reusing exactly what already exists.
        const results = await Promise.all(
          components.map(async (component) => {
            const result = await getLatestTestResult(component.id);
            return result ? { component, result } : null;
          }),
        );
        setTestedComponents(results.filter((entry): entry is TestedComponent => entry !== null));
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not load test results.");
      });
  }, []);

  return (
    <main className="page-content">
      <div className="page-heading">
        <p className="eyebrow">HARDWARE VERIFICATION</p>
        <h3>Physical Testing</h3>
        <p>
          Electrical measurements received from the testing
          station will appear here.
        </p>
      </div>

      <div className="test-status">
        <div className="test-status-icon">
          <Zap size={22} />
        </div>

        <div>
          <strong>ESP32 testing station</strong>
          <span>Not yet implemented — physical hardware testing is a planned future phase</span>
        </div>

        <span className="connection-badge">
          Offline
        </span>
      </div>

      {error && (
        <section className="info-panel info-panel-error">
          <AlertTriangle size={20} />
          <div>
            <strong>Could not load test results</strong>
            <p>{error}</p>
          </div>
        </section>
      )}

      {testedComponents && testedComponents.length === 0 && !error && (
        <div className="empty-state">
          <TestTube size={32} />
          <h4>No test results yet</h4>
          <p>
            No component has a recorded test result. Physical testing
            requires the ESP32 hardware workflow, which isn't built yet.
          </p>
        </div>
      )}

      <div className="test-grid">
        {testedComponents?.map(({ component, result }) => (
          <div className="test-card" key={result.id}>
            <div className="test-card-heading">
              <div>
                <span>{component.id.slice(0, 8)}</span>
                <h4>{component.name || component.type}</h4>
              </div>

              <Activity size={20} />
            </div>

            <div className="measurement-row">
              <span>Expected</span>
              <strong>
                {result.expected_value ?? "–"}{" "}
                {result.unit}
              </strong>
            </div>

            <div className="measurement-row">
              <span>Measured</span>
              <strong>
                {result.measured_value ?? "–"}{" "}
                {result.unit}
              </strong>
            </div>

            <div className={`test-result ${result.status}`}>
              {result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "–"} {result.status}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default Testing;
