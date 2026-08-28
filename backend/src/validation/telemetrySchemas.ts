import { z } from "zod";

export const telemetryProcessSchema = z.object({
  pid: z.number().int().nonnegative(),
  name: z.string().min(1),
  working_set_mb: z.number().nonnegative(),
  commit_mb: z.number().nonnegative(),
});

export const telemetryMemorySchema = z.object({
  total_gb: z.number().positive(),
  used_mb: z.number().nonnegative(),
  free_mb: z.number().nonnegative(),
  used_percent: z.number().min(0).max(100),
  standby_mb: z.number().nonnegative(),
  modified_mb: z.number().nonnegative(),
  hard_faults_per_sec: z.number().nonnegative(),
});

export const telemetryPayloadSchema = z.object({
  agent_id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  system_metrics: z.object({
    memory: telemetryMemorySchema,
  }),
  top_processes: z.array(telemetryProcessSchema).max(10),
});

export type ValidatedTelemetryPayload = z.infer<
  typeof telemetryPayloadSchema
>;