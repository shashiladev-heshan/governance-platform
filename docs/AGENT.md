# The validator agent

The only place an LLM touches this system. Everything about its design follows
from one constraint: **it supplies findings; it does not decide merges.**

## Pipeline

```
PR diff
  └─ parseDiff        drop generated/vendored/.governance paths, keep .ts/.tsx/.js
  └─ chunkFiles       group small related files (~12k chars) so layering rules have context
  └─ loadRubric       only rules whose tier enforcement ≠ off, and only their skills
  └─ buildSystemPrompt  assembled entirely from governed content
  └─ provider.review  Claude Agent SDK, outputFormat: json_schema, no tools
  └─ Zod re-validation
  └─ scope filter     discard findings on files the agent was not shown
  └─ dedupe
  └─ gateVerdict      ← policy-core, deterministic, tier-aware
```

The deterministic layers run first. `semgrep` handles the mechanical cases in its
own CI job, so the agent never spends tokens on `process.env` reads or empty catch
blocks — it only gets asked the questions a linter cannot answer.

## Guardrails, and what each one prevents

| Guardrail | Prevents |
|---|---|
| `outputFormat: json_schema` + Zod re-validation | Free-form output reaching the gate |
| Malformed verdict → empty findings **+ degraded** | A parse failure silently reading as "clean" |
| Unknown rule id → warn, never block, listed separately | The agent inventing a blocking rule |
| Findings on unshown files discarded | Hallucinated file paths |
| `allowedTools: []`, `settingSources: []` | The agent reading files the integrity job never verified |
| Chunk budget with named skipped files | A large diff quietly getting a partial review |
| Degraded review cannot report `pass` | Claiming clean for work that was not looked at |
| Diff wrapped in `<diff>`, declared untrusted data | Prompt injection from code, comments or commit text |
| `gate` exits 2 on a missing/unreadable verdict | The check going green because the agent step fell over |

The last one is worth stating plainly: if the agent errors, the API is down, or the
verdict file is missing, `governance-semantic` **fails**. It never passes by default.

## Prompt construction

The system prompt is built only from the resolved policy and the verified
`SKILL.md` bodies. The diff contributes no instructions. The prompt says so
explicitly, and asks the agent to flag any injection attempt it notices as
something worth mentioning in its notes.

Precision is preferred over recall, on purpose:

> A false positive costs more trust than a missed finding costs quality — the
> deterministic checks catch the mechanical cases anyway. When genuinely unsure,
> stay silent.

## Calibration — before turning blocking on

The gate is tier-driven, so calibration is a policy change, not a code change.

1. Run on pilot repos with every semantic rule at `warn` for two weeks. The
   easiest way is a `tiers/pilot.yaml` with `defaults: { enforcement: warn }`.
2. Every finding gets triaged as true/false positive. `renderMarkdown` attributes
   each one to a rule id, which is what makes per-rule FP rates measurable.
3. Tune the **skill**, not the prompt, where possible. If a rule produces false
   positives, its SKILL.md is ambiguous — add the counter-example that would have
   prevented it. That fix helps Claude Code in the editor too.
4. Promote a rule to `block` in `tiers/corporate.yaml` only when its own FP rate is
   under 10%. Promote per rule, not all at once.

Exit criterion from the plan: FP < 10% and median review under 4 minutes before
corporate-tier blocking is enabled.

## Cost control

- `semgrep` pre-filter — mechanical findings cost nothing
- skip list — generated, vendored, lock files, images, `.governance/` itself
- only rules active for the tier enter the rubric
- `GOVERNANCE_MAX_CHUNKS` (default 20) caps agent calls per PR
- concurrency 3, so a large PR is wall-clock bounded

Model defaults to `claude-sonnet-5`; override with `GOVERNANCE_MODEL`. Reserve
larger models for calibration runs where judgement quality is being measured.

## Running it without an API key

```bash
GOVERNANCE_AGENT_MODE=mock \
GOVERNANCE_MOCK_VERDICT='{"findings":[{"ruleId":"thin-controllers","severity":"error","file":"src/a.ts","rationale":"..."}]}' \
governance-validator review --diff pr.diff --governance .governance --config governance.json
```

The mock provider runs the entire pipeline — chunking, validation, gating,
rendering. It is how the gate stays testable in CI without spending tokens, and
it is what `packages/validator-agent/test/review.test.js` uses.

## Tracing

Each chunk emits one event to Langfuse when `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`
and `LANGFUSE_SECRET_KEY` are set: label, tier, governance version, finding count,
degradation reason, tokens, cost. Fire-and-forget — observability never fails a PR
check. `GOVERNANCE_TRACE_STDOUT=1` prints the same events locally.

That trace stream is the input to the calibration loop above: per-rule finding
counts, per-repo dispute rates, and cost per PR.
