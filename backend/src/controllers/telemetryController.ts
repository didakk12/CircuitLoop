import type { Request, Response } from "express";

import { analyzeTelemetry } from "../services/telemetryService.js";
import {
getLatestTelemetry,
saveLatestTelemetry,
} from "../services/telemetryState.js";
import type { TelemetryResponse } from "../types/telemetry.js";
import { telemetryPayloadSchema } from "../validation/telemetrySchemas.js";

export async function receiveTelemetry(
req: Request,
res: Response<TelemetryResponse>,
): Promise<void> {
const telemetry = telemetryPayloadSchema.parse(req.body);

const result = analyzeTelemetry(telemetry);

saveLatestTelemetry(telemetry, result);

res.status(200).json(result);
}

export async function getTelemetry(
_req: Request,
res: Response,
): Promise<void> {
const latest = getLatestTelemetry();

if (!latest) {
res.status(404).json({
detail: "No telemetry has been received yet.",
});
return;
}

res.status(200).json(latest);
}
