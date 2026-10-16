---
description: Show the latest Claude Code usage-limit and auto-resume event
allowed-tools:
  - Bash
---

Show the user the latest status from this command:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/show-status.mjs"`

Then explain that quota detection and automatic continuation are handled by Claude Code itself. If the status is empty, mention that only events occurring after plugin installation are recorded.
