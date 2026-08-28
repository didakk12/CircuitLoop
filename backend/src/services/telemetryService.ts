import type {
  TelemetryResponse,
} from "../types/telemetry.js";
import type { ValidatedTelemetryPayload } from "../validation/telemetrySchemas.js";

/**
 * Thresholds used by the diagnostic decision engine.
 *
 * These values are intentionally conservative for the demonstration
 * environment and can be tuned after testing with real telemetry.
 */
const MEMORY_WARNING_THRESHOLD_PERCENT = 90;
const PROCESS_WARNING_THRESHOLD_MB = 4096;

/**
 * Processes that the automated remediation engine is NEVER allowed
 * to terminate.
 *
 * These are common Windows/system processes and development tools that
 * could destabilize the machine or the CircuitLoop development environment.
 */
const PROTECTED_PROCESS_NAMES = new Set([
  "System",
  "System Idle Process",
  "Registry",
  "smss",
  "csrss",
  "wininit",
  "services",
  "lsass",
  "svchost",
  "winlogon",
  "explorer",
  "dwm",
  "powershell",
  "pwsh",
  "cmd",
  "node",
  "npm",
  "code",
]);

/**
 * Only processes explicitly marked as safe for automated remediation
 * may be terminated.
 *
 * For the initial demonstration this is empty.
 *
 * We will add a harmless test process here when we perform the
 * end-to-end remediation test.
 */
const REMEDIATION_ALLOWLIST = new Set<string>();

export function analyzeTelemetry(
  telemetry: ValidatedTelemetryPayload,
): TelemetryResponse {
  const memory = telemetry.system_metrics.memory;

  // --------------------------------------------------------------------------
  // Normal condition
  // --------------------------------------------------------------------------

  if (memory.used_percent < MEMORY_WARNING_THRESHOLD_PERCENT) {
    return {
      status: "NORMAL",
    };
  }

  // --------------------------------------------------------------------------
  // High memory condition
  // --------------------------------------------------------------------------

  const suspiciousProcess = telemetry.top_processes.find(
    (process) => process.working_set_mb >= PROCESS_WARNING_THRESHOLD_MB,
  );

  // High RAM but no unusually large process.
  if (suspiciousProcess === undefined) {
    return {
      status: "ACTION_REQUIRED",
      action_id: "EMPTY_WORKING_SETS",
    };
  }

  // --------------------------------------------------------------------------
  // Safety checks before allowing process termination
  // --------------------------------------------------------------------------

  const normalizedProcessName = suspiciousProcess.name.toLowerCase();

  const isProtected = PROTECTED_PROCESS_NAMES.has(
    suspiciousProcess.name,
  );

  const isAllowlisted = REMEDIATION_ALLOWLIST.has(
    normalizedProcessName,
  );

  // Never automatically terminate a protected or unknown process.
  if (isProtected || !isAllowlisted) {
    return {
      status: "ACTION_REQUIRED",
      action_id: "EMPTY_WORKING_SETS",
    };
  }

  // --------------------------------------------------------------------------
  // Explicitly approved remediation target
  // --------------------------------------------------------------------------

  return {
    status: "ACTION_REQUIRED",
    action_id: "KILL_PROCESS",
    target_pid: suspiciousProcess.pid,
  };
}