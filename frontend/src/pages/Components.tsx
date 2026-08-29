import { AlertTriangle, Cpu, Search, TestTube } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, componentIdentity, getComponents } from "../api";
import type { ApiComponent } from "../api";

function Components() {
  const navigate = useNavigate();

  const [components, setComponents] = useState<ApiComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    getComponents()
      .then(setComponents)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not load components.",
        );
      });
  }, []);

  const filteredComponents = components?.filter((component) => {
    const searchValue = search.toLowerCase();

    return (
      component.id.toLowerCase().includes(searchValue) ||
      component.type.toLowerCase().includes(searchValue) ||
      (component.name?.toLowerCase().includes(searchValue) ?? false)
    );
  });

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

          <input
            placeholder="Search components..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <span>
          {filteredComponents ? filteredComponents.length : 0} components
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

          <p>
            Scan a PCB to start identifying reusable components.
          </p>
        </div>
      )}

      <div className="component-grid">
        {filteredComponents?.map((component) => (
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
              {componentIdentity(component)}
            </p>

            {component.name && (
              <p className="component-marking" title={component.name}>
                {component.name}
              </p>
            )}

            <div className="component-confidence">
              <span>Identification</span>

              <strong>
                {Math.round(component.confidence * 100)}%
              </strong>
            </div>

            <button
              type="button"
              className="scan-button"
              onClick={() =>
                navigate(`/testing?component=${component.id}`)
              }
            >
              <TestTube size={16} />
              Test Component
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}

export default Components;
