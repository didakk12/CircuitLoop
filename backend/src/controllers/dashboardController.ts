import type { Request, Response } from "express";

import * as dashboardService from "../services/dashboardService.js";
import { toDashboardStatsResponse, type DashboardStatsResponse } from "../types/dto.js";

export async function getStats(_req: Request, res: Response<DashboardStatsResponse>): Promise<void> {
  const stats = await dashboardService.getStats();
  res.status(200).json(toDashboardStatsResponse(stats));
}
