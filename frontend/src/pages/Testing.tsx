import { Activity, Zap } from "lucide-react";
import { mockScan } from "../data/mockScan";

function Testing() {
  const testedComponents = mockScan.components.filter(
    (component) =>
      component.test.status !== "NOT_TESTED" &&
      component.test.status !== "NOT_SUPPORTED",
  );

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
          <strong>Testing station</strong>
          <span>Waiting for hardware connection</span>
        </div>

        <span className="connection-badge">
          Offline
        </span>
      </div>

      <div className="test-grid">
        {testedComponents.map((component) => (
          <div className="test-card" key={component.id}>
            <div className="test-card-heading">
              <div>
                <span>{component.id}</span>
                <h4>{component.value}</h4>
              </div>

              <Activity size={20} />
            </div>

            <div className="measurement-row">
              <span>Expected</span>
              <strong>
                {component.test.expected}{" "}
                {component.test.unit}
              </strong>
            </div>

            <div className="measurement-row">
              <span>Measured</span>
              <strong>
                {component.test.measured}{" "}
                {component.test.unit}
              </strong>
            </div>

            <div className="test-result pass">
              ✓ {component.test.status}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default Testing;