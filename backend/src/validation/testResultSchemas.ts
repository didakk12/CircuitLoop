import { z } from "zod";

import { componentStatusSchema } from "./common.js";

/**
 * Ports the `require_measurement_for_tested_result` model validator from the
 * original Python `schemas.py::TestResultCreate` verbatim: a `pass`/`fail`
 * result must include a `measured_value`; `not_tested` doesn't need one.
 */
export const createTestResultBodySchema = z
  .object({
    expected_value: z.number().nullish(),
    measured_value: z.number().nullish(),
    unit: z.string().nullish(),
    status: componentStatusSchema,
  })
  .refine(
    (body) => !(["pass", "fail"].includes(body.status) && (body.measured_value === null || body.measured_value === undefined)),
    {
      message: "measured_value is required for pass or fail results",
      path: ["measured_value"],
    },
  );

export type CreateTestResultBody = z.infer<typeof createTestResultBodySchema>;
