import type { TelemetryResponse } from "../types/telemetry.js";
import type { ValidatedTelemetryPayload } from "../validation/telemetrySchemas.js";

export interface LatestTelemetry {
telemetry: ValidatedTelemetryPayload;
response: TelemetryResponse;
received_at: string;
}

let latestTelemetry: LatestTelemetry | null = null;

export function saveLatestTelemetry(
telemetry: ValidatedTelemetryPayload,
response: TelemetryResponse,
): void {
latestTelemetry = {
telemetry,
response,
received_at: new Date().toISOString(),
};
}

export function getLatestTelemetry(): LatestTelemetry | null {
return latestTelemetry;
}
