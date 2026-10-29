import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const SuggestionStatusSchema = z.enum(["pending", "accepted", "ignored"]);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

export const ProactiveSuggestionSchema = z.object({
  id: Id,
  spaceId: Id,
  userId: Id,
  botId: Id,
  botName: z.string(),
  botColor: z.string(),
  source: z.string(),
  title: z.string(),
  rationale: z.string(),
  instruction: z.string(),
  status: SuggestionStatusSchema,
  runId: Id.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ProactiveSuggestion = z.infer<typeof ProactiveSuggestionSchema>;

export const GenerateSuggestionsOutputSchema = z.object({
  suggestions: z.array(ProactiveSuggestionSchema),
  created: z.number().int().nonnegative(),
});
export type GenerateSuggestionsOutput = z.infer<typeof GenerateSuggestionsOutputSchema>;
