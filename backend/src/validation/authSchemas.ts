import { z } from "zod";

/**
 * Credentials for register and login.
 *
 * The minimum length is a floor against trivially weak passwords, not a
 * complexity policy — length is the property that actually matters, and
 * character-class rules mostly push people toward predictable substitutions.
 * The cap exists because bcrypt silently truncates at 72 bytes, so accepting
 * more would create passwords whose tails are ignored.
 */
export const credentialsSchema = z.object({
  email: z.string().trim().min(1, "email is required").email("email must be a valid address"),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(72, "password must be at most 72 characters"),
});

export type CredentialsBody = z.infer<typeof credentialsSchema>;
