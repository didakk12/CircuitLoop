import { Cpu, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { getComponents } from "../api";
import type { ApiComponent } from "../api";

function Components() {
  const [components, setComponents] = useState<ApiComponent[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getComponents()
      .then(setComponents)
      .catch((requestError: Error) => setError(requestError.message));
  }, []);

  const filteredComponents = components.filter((component) =>
    `${component.name ?? ""} ${component.type}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

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
          {error ?? `${filteredComponents.length} components`}
        </span>
      </div>

      <div className="component-grid">
        {filteredComponents.map((component) => (
          <div className="component-card" key={component.id}>
            <div className="component-card-top">
              <div className="component-icon">
                <Cpu size={20} />
              </div>

              <span
                className={`priority priority-${component.status === "not_tested" ? "medium" : "high"}`}
              >
                {component.status.replace("_", " ")}
              </span>
            </div>

            <h4>{component.name ?? `Component ${component.id}`}</h4>

            <p className="component-type">
              {component.type}
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