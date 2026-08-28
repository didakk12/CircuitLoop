import { z } from "zod";

export const askAssistantBodySchema = z.object({
  component_id: z.string().min(1, "component_id must not be empty"),
  question: z.string().min(1, "question must not be empty"),
});

export type AskAssistantBody = z.infer<typeof askAssistantBodySchema>;
