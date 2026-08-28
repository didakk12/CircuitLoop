import type { Request, Response } from "express";

import { requireUser } from "../middleware/auth.js";
import * as dashboardService from "../services/dashboardService.js";
import { toDashboardStatsResponse, type DashboardStatsResponse } from "../types/dto.js";

export async function getStats(req: Request, res: Response<DashboardStatsResponse>): Promise<void> {
  const user = requireUser(req);
  const stats = await dashboardService.getStats(user.id);
  res.status(200).json(toDashboardStatsResponse(stats));
}
