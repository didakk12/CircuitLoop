import {
  Activity,
  Bot,
  CircuitBoard,
  FileText,
  History as HistoryIcon,
  LayoutDashboard,
  LogOut,
  ScanLine,
  Settings,
  TestTube,
} from "lucide-react";

import {
  Navigate,
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
import History from "./pages/History";
import Telemetry from "./pages/Telemetry";
import SignIn from "./pages/SignIn";
import { useAuth } from "./auth/AuthContext";


function App() {
  const location = useLocation();
  const { user, loading, signOut } = useAuth();

  // Wait for the initial session check before deciding. Rendering the sign-in
  // page during the check would flash it at users who are already signed in.
  if (loading) {
    return (
      <div className="app-loading">
        <CircuitBoard size={28} />
        <p>Loading…</p>
      </div>
    );
  }

  if (user === null) {
    // Remember where they were headed so signing in resumes it.
    return (
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route
          path="*"
          element={<Navigate to="/signin" replace state={{ from: location.pathname }} />}
        />
      </Routes>
    );
  }

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
      case "/history":
        return "Scan History";
      case "/testing":
        return "Testing";
      case "/reports":
        return "Reports";
      case "/assistant":
        return "AI Assistant";
      default:
        return "Dashboard";
        case "/telemetry":
        return "Telemetry";
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
            to="/history"
            className={({ isActive }) =>
              `nav-item ${isActive ? "active" : ""}`
            }
          >
            <HistoryIcon size={19} />
            History
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
           to="/telemetry"
          className={({ isActive }) =>
             `nav-item ${isActive ? "active" : ""}`
           }
>
           <Activity size={19} />
          Telemetry
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

          <div className="topbar-actions">
            <span className="topbar-user" title={user.email}>
              {user.email}
            </span>

            <button type="button" className="signout-button" onClick={() => void signOut()}>
              <LogOut size={16} />
              Sign out
            </button>

            <NavLink to="/scan" className="scan-button">
              <ScanLine size={18} />
              New Scan
            </NavLink>
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/scan" element={<ScanPCB />} />
          <Route path="/analysis" element={<Analysis />} />
          <Route path="/history" element={<History />} />
          <Route path="/components" element={<Components />} />
          <Route path="/testing" element={<Testing />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/telemetry" element={<Telemetry />} />
          {/* Already signed in — nothing to do on the sign-in route. */}
          <Route path="/signin" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;