import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerClaudeQuotaResume } from "./src/plugin.ts";

export default definePluginEntry({
  id: "claude-quota-resume",
  name: "Claude Quota Resume",
  description: "Queue original requests and retry after Claude subscription limits reset.",
  register(api) {
    registerClaudeQuotaResume(api as never);
  },
});
