import {
  Bot,
  CircuitBoard,
  FileText,
  LayoutDashboard,
  ScanLine,
  Settings,
  TestTube,
} from "lucide-react";

import {
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import Dashboard from "./pages/Dashboard";
import ScanPCB from "./pages/ScanPCB";
import Analysis from "./pages/Analysis";
import Components from "./pages/Components";
import Testing from "./pages/Testing";
import Reports from "./pages/Reports";
import Assistant from "./pages/Assistant";

function App() {
  const location = useLocation();

  const getPageName = () => {
    switch (location.pathname) {
      case "/":
        return "Dashboard";
      case "/scan":
        return "Scan PCB";
      case "/analysis":
        return "PCB Analysis";
      case "/components":
        return "Components";
      case "/testing":
        return "Testing";
      case "/reports":
        return "Reports";
      case "/assistant":
        return "AI Assistant";
      default:
        return "Dashboard";
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          <div className="brand-icon">
            <CircuitBoard size={24} />
          </div>

          <div>
            <h1>CircuitLoop</h1>
            <span>PCB Salvage Assistant</span>
          </div>
        </NavLink>

        <nav className="navigation">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <LayoutDashboard size={19} />
            Dashboard
          </NavLink>

          <NavLink
            to="/scan"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <ScanLine size={19} />
            Scan PCB
          </NavLink>

          <NavLink
            to="/analysis"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <CircuitBoard size={19} />
            Analysis
          </NavLink>

          <NavLink
            to="/components"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <CircuitBoard size={19} />
            Components
          </NavLink>

          <NavLink
            to="/testing"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <TestTube size={19} />
            Testing
          </NavLink>

          <NavLink
            to="/reports"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <FileText size={19} />
            Reports
          </NavLink>

          <NavLink
            to="/assistant"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <Bot size={19} />
            AI Assistant
          </NavLink>
        </nav>

        <div className="sidebar-bottom">
          <a className="nav-item" href="#">
            <Settings size={19} />
            Settings
          </a>

          <div className="system-status">
            <span className="status-dot" />
            System ready
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">PCB SALVAGE WORKSPACE</p>
            <h2>{getPageName()}</h2>
          </div>

          <NavLink to="/scan" className="scan-button">
            <ScanLine size={18} />
            New Scan
          </NavLink>
        </header>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/scan" element={<ScanPCB />} />
          <Route path="/analysis" element={<Analysis />} />
          <Route path="/components" element={<Components />} />
          <Route path="/testing" element={<Testing />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/assistant" element={<Assistant />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;