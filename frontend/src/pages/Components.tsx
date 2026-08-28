import { AlertTriangle, Cpu, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, getComponents } from "../api";
import type { ApiComponent } from "../api";

function Components() {
  const [components, setComponents] = useState<ApiComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getComponents()
      .then(setComponents)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Could not load components.");
      });
  }, []);

  return (
    <main className="page-content">
      <div className="page-heading">
        <p className="eyebrow">COMPONENT INVENTORY</p>
        <h3>Detected Components</h3>
        <p>
          Explore the components identified during PCB analysis.
        </p>
      </div>

      <div className="component-toolbar">
        <div className="search-box">
          <Search size={17} />
          <input placeholder="Search components..." />
        </div>

        <span>
          {components ? components.length : 0} components
        </span>
      </div>

      {error && (
        <section className="info-panel info-panel-error">
          <AlertTriangle size={20} />
          <div>
            <strong>Could not load components</strong>
            <p>{error}</p>
          </div>
        </section>
      )}

      {components && components.length === 0 && !error && (
        <div className="empty-state">
          <Cpu size={32} />
          <h4>No components yet</h4>
          <p>Scan a PCB to start identifying reusable components.</p>
        </div>
      )}

      <div className="component-grid">
        {components?.map((component) => (
          <div className="component-card" key={component.id}>
            <div className="component-card-top">
              <div className="component-icon">
                <Cpu size={20} />
              </div>

              {component.salvage_priority && (
                <span
                  className={`priority priority-${component.salvage_priority}`}
                >
                  {component.salvage_priority} priority
                </span>
              )}
            </div>

            <h4>{component.id.slice(0, 8)}</h4>

            <p className="component-type">
              {component.name || component.type}
            </p>

            <div className="component-confidence">
              <span>Identification</span>

              <strong>
                {Math.round(component.confidence * 100)}%
              </strong>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

export default Components;
