---
description: Review the current changes against the governed pattern skills before opening a PR (advisory — same rubric as CI).
---

Run the governance validator locally against the working tree, using the same
rubric and the same tier policy that the required CI check will use.

1. Confirm the project is governed and intact:

   ```bash
   govctl status
   ```

   If it reports drift, stop and tell the user to run `govctl restore` — reviewing
   against tampered rules is worse than not reviewing.

2. Produce the diff to review (staged changes if any, otherwise the branch diff
   against the default branch):

   ```bash
   git diff --staged --unified=3 || git diff origin/HEAD... --unified=3
   ```

3. Run the validator over that diff:

   ```bash
   npx governance-validator review --diff - --tier "$(node -p "require('./governance.json').tier")"
   ```

4. Report the findings grouped by severity. For each finding, quote the rule id
   and the rationale from the skill so the developer learns the pattern rather
   than just seeing a rejection.

This is advisory only. It never gates anything locally — it exists so a developer
finds out before the PR, not after.
