import type { QueryRunner } from "../db/session.js";
import * as dashboardRepository from "../repositories/dashboardRepository.js";
import type { DashboardStats } from "../types/entities.js";

export async function getStats(runner?: QueryRunner): Promise<DashboardStats> {
  return dashboardRepository.getStats(runner);
}
