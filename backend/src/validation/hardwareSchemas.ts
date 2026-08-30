import { z } from "zod";

/**
 * Upper bound on an action string.
 *
 * Generous relative to any real firmware command (`I2C_PROBE:0x27`,
 * `COMPONENT_TEST`, `RELAY_TOGGLE:3`) but small enough that a client cannot
 * push an unbounded blob down a 115200-baud serial line and hold the
 * single-in-flight lock for minutes while it drains.
 */
export const MAX_ACTION_CHARS = 128;

/**
 * Characters that must never reach the wire inside an action.
 *
 * The service appends "\n" as the line terminator, so an embedded newline
 * would smuggle a *second* command onto the wire inside one request — one
 * the correlator never saw sent, and whose reply would be matched to the
 * wrong command. Every other C0/DEL control character is rejected for the
 * same framing reason rather than trying to enumerate which ones a given
 * firmware happens to treat as significant.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * `POST /api/hardware/action`.
 *
 * Deliberately **not** a closed enum. The firmware's command vocabulary is
 * expected to grow — `COMPONENT_TEST`, `CAPTURE_READING`, `LCD_SCAN`,
 * `PINOUT_CHECK`, `RELAY_TOGGLE` — and an enum here would mean a backend
 * release for every one of them. Validation therefore constrains the
 * *shape* of an action, not its vocabulary: non-empty, length-bounded, and
 * free of the characters that would break framing.
 */
export const hardwareActionBodySchema = z.object({
  action: z
    .string()
    .trim()
    .min(1, "action must not be empty")
    .max(MAX_ACTION_CHARS, `action must be at most ${MAX_ACTION_CHARS} characters`)
    .refine((action) => !CONTROL_CHARACTERS.test(action), {
      message: "action must not contain newlines or other control characters",
    }),
  /**
   * Optional target component. Omitted or null means a gateway-level command
   * that belongs to no component — the same distinction `(:Command).componentId`
   * records. When set it must be a component the caller owns, which the
   * service enforces through the repository's ownership-scoped Cypher.
   */
  component_id: z.string().min(1, "component_id must not be empty").nullish().default(null),
});

export type HardwareActionBody = z.infer<typeof hardwareActionBodySchema>;
