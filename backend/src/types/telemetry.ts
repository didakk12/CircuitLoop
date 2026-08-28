export interface TelemetryMemory {
  readonly total_gb: number;
  readonly used_mb: number;
  readonly free_mb: number;
  readonly used_percent: number;
  readonly standby_mb: number;
  readonly modified_mb: number;
  readonly hard_faults_per_sec: number;
}

export interface TelemetryProcess {
  readonly pid: number;
  readonly name: string;
  readonly working_set_mb: number;
  readonly commit_mb: number;
}

export interface TelemetryPayload {
  readonly agent_id: string;
  readonly timestamp: string;
  readonly system_metrics: {
    readonly memory: TelemetryMemory;
  };
  readonly top_processes: readonly TelemetryProcess[];
}

export type TelemetryActionId =
  | "KILL_PROCESS"
  | "EMPTY_WORKING_SETS";

export interface TelemetryNormalResponse {
  readonly status: "NORMAL";
}

export interface TelemetryActionResponse {
  readonly status: "ACTION_REQUIRED";
  readonly action_id: TelemetryActionId;
  readonly target_pid?: number;
}

export type TelemetryResponse =
  | TelemetryNormalResponse
  | TelemetryActionResponse;