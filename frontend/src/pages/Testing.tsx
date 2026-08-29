import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  TestTube,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  ApiError,
  componentIdentity,
  createTestResult,
  getComponents,
  getLatestTestResult,
} from "../api";

import type {
  ApiComponent,
  ApiTestResult,
  ComponentStatus,
} from "../api";

interface TestedComponent {
  component: ApiComponent;
  result: ApiTestResult;
}

function Testing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const selectedComponentId = searchParams.get("component");

  const [components, setComponents] = useState<ApiComponent[] | null>(null);
  const [testedComponents, setTestedComponents] = useState<
    TestedComponent[] | null
  >(null);

  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [expectedValue, setExpectedValue] = useState("");
  const [measuredValue, setMeasuredValue] = useState("");
  const [unit, setUnit] = useState("");
  const [status, setStatus] = useState<ComponentStatus>("pass");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedComponent = components?.find(
    (component) => component.id === selectedComponentId,
  );

  useEffect(() => {
    getComponents()
      .then(async (loadedComponents) => {
        setComponents(loadedComponents);

        const results = await Promise.all(
          loadedComponents.map(async (component) => {
            const result = await getLatestTestResult(component.id);

            return result ? { component, result } : null;
          }),
        );

        setTestedComponents(
          results.filter(
            (entry): entry is TestedComponent => entry !== null,
          ),
        );
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not load test results.",
        );
      });
  }, []);

  const handleSubmitTest = async () => {
    if (!selectedComponentId) {
      setFormError("Please select a component to test.");
      return;
    }

    setFormError(null);

    if (
      (status === "pass" || status === "fail") &&
      measuredValue.trim() === ""
    ) {
      setFormError(
        "Measured value is required for a pass or fail result.",
      );
      return;
    }

    if (
      expectedValue.trim() !== "" &&
      Number.isNaN(Number(expectedValue))
    ) {
      setFormError("Expected value must be a valid number.");
      return;
    }

    if (
      measuredValue.trim() !== "" &&
      Number.isNaN(Number(measuredValue))
    ) {
      setFormError("Measured value must be a valid number.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await createTestResult(selectedComponentId, {
        expected_value:
          expectedValue.trim() === ""
            ? null
            : Number(expectedValue),

        measured_value:
          measuredValue.trim() === ""
            ? null
            : Number(measuredValue),

        unit: unit.trim() === "" ? null : unit.trim(),

        status,
      });

      const component = selectedComponent;

      if (component) {
        setTestedComponents((current) => {
          const existing =
            current?.filter(
              (entry) => entry.component.id !== component.id,
            ) ?? [];

          return [...existing, { component, result }];
        });
      }

      setExpectedValue("");
      setMeasuredValue("");
      setUnit("");
      setStatus("pass");

      navigate("/testing");
    } catch (err: unknown) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : "Could not save the test result.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

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

          <span>
            Not yet implemented — physical hardware testing is a planned
            future phase
          </span>
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

      {selectedComponentId && selectedComponent && (
        <section className="info-panel">
          <div>
            <strong>
              Testing:{" "}
              {componentIdentity(selectedComponent)}
            </strong>

            {selectedComponent.name && (
              <p className="component-marking">
                Markings: {selectedComponent.name}
              </p>
            )}

            <p>
              Component ID: {selectedComponent.id.slice(0, 8)}
            </p>

            <div className="measurement-row">
              <span>Expected value</span>

              <input
                type="number"
                value={expectedValue}
                onChange={(event) =>
                  setExpectedValue(event.target.value)
                }
                placeholder="e.g. 100"
              />
            </div>

            <div className="measurement-row">
              <span>Measured value</span>

              <input
                type="number"
                value={measuredValue}
                onChange={(event) =>
                  setMeasuredValue(event.target.value)
                }
                placeholder="e.g. 98.5"
              />
            </div>

            <div className="measurement-row">
              <span>Unit</span>

              <input
                type="text"
                value={unit}
                onChange={(event) =>
                  setUnit(event.target.value)
                }
                placeholder="e.g. Ω, V, μF"
              />
            </div>

            <div className="measurement-row">
              <span>Status</span>

              <select
                value={status}
                onChange={(event) =>
                  setStatus(
                    event.target.value as ComponentStatus,
                  )
                }
              >
                <option value="pass">Pass</option>
                <option value="fail">Fail</option>
                <option value="not_tested">
                  Not Tested
                </option>
              </select>
            </div>

            {formError && (
              <section className="info-panel info-panel-error">
                <AlertTriangle size={20} />

                <div>
                  <strong>Could not save test</strong>
                  <p>{formError}</p>
                </div>
              </section>
            )}

            <button
              type="button"
              className="scan-button"
              onClick={() => void handleSubmitTest()}
              disabled={isSubmitting}
            >
              <TestTube size={17} />

              {isSubmitting
                ? "Saving..."
                : "Save Test Result"}
            </button>
          </div>
        </section>
      )}

      {selectedComponentId &&
        !selectedComponent &&
        components && (
          <section className="info-panel info-panel-error">
            <AlertTriangle size={20} />

            <div>
              <strong>Component not found</strong>

              <p>
                The selected component could not be found.
              </p>
            </div>
          </section>
        )}

      {!selectedComponentId && (
        <section className="info-panel">
          <ArrowLeft size={20} />

          <div>
            <strong>Select a component to test</strong>

            <p>
              Go to the Components page and select a component
              to record a manual test result.
            </p>
          </div>
        </section>
      )}

      {testedComponents &&
        testedComponents.length === 0 &&
        !error && (
          <div className="empty-state">
            <TestTube size={32} />

            <h4>No test results yet</h4>

            <p>
              No component has a recorded test result. Select a
              component below to manually record a test result.
            </p>
          </div>
        )}

      <div className="test-grid">
        {testedComponents?.map(({ component, result }) => (
          <div className="test-card" key={result.id}>
            <div className="test-card-heading">
              <div>
                <span>
                  {component.id.slice(0, 8)}
                </span>

                <h4>
                  {componentIdentity(component)}
                </h4>

                {component.name && (
                  <span className="component-marking" title={component.name}>
                    {component.name}
                  </span>
                )}
              </div>

              <Activity size={20} />
            </div>

            <div className="measurement-row">
              <span>Expected</span>

              <strong>
                {result.expected_value ?? "–"}{" "}
                {result.unit ?? ""}
              </strong>
            </div>

            <div className="measurement-row">
              <span>Measured</span>

              <strong>
                {result.measured_value ?? "–"}{" "}
                {result.unit ?? ""}
              </strong>
            </div>

            <div
              className={`test-result ${result.status}`}
            >
              {result.status === "pass"
                ? "✓"
                : result.status === "fail"
                  ? "✗"
                  : "–"}{" "}
              {result.status}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default Testing;
