import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

// The model is the runner pool's configuration (HANDOFF_MODEL), with the key in the runner's own
// environment (ANTHROPIC_API_KEY). Handoff stores only the agent's model reference.
export default defineAgent({
  model: anthropic(process.env.HANDOFF_MODEL ?? "claude-sonnet-5-5"),
  reasoning: "high",
});
