import { Cpu, Search } from "lucide-react";
import { mockScan } from "../data/mockScan";

function Components() {
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
          {mockScan.components.length} components
        </span>
      </div>

      <div className="component-grid">
        {mockScan.components.map((component) => (
          <div className="component-card" key={component.id}>
            <div className="component-card-top">
              <div className="component-icon">
                <Cpu size={20} />
              </div>

              <span
                className={`priority priority-${component.salvagePriority}`}
              >
                {component.salvagePriority} priority
              </span>
            </div>

            <h4>{component.id}</h4>

            <p className="component-type">
              {component.value || component.type}
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