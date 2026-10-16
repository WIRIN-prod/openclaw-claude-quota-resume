---
description: Explain how to enable Claude Code's native usage-limit auto-continue
---

Explain how to use Claude Code's built-in usage-limit wait and automatic continuation:

1. This requires Claude Code v2.1.234 or later and an eligible interactive session signed in with a claude.ai subscription. API-key, cloud-provider, usage-billed, and background `-p` sessions do not offer the same subscription reset wait.
2. Run `/config` and enable **Continue automatically at usage limit**. Claude Code may still offer the wait as a choice when it is not configured to start automatically.
3. The current release's auto-continue is owned by Claude Code. This plugin only records `rate_limit` and native `quota_auto_resume_*` hook events; it never resubmits prompts or starts another Claude process.
4. Use `/quota-resume:status` to see the latest recorded event. If the computer sleeps through the reset, Claude Code may require Enter to continue. If auto-continue ends without resuming, review the error in the session and `/config`.

Do not edit user settings automatically. Enabling unattended continuation requires the user's explicit choice in Claude Code's configuration UI.
