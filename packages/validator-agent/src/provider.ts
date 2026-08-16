import { AgentVerdictSchema, VERDICT_JSON_SCHEMA, type AgentVerdict } from './schema.js';

export interface ReviewRequest {
  systemPrompt: string;
  userPrompt: string;
  label: string;
}

export interface ProviderResult {
  verdict: AgentVerdict;
  /** Set when the provider could not produce a usable verdict for this chunk. */
  degradedReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface ReviewProvider {
  readonly name: string;
  review(request: ReviewRequest): Promise<ProviderResult>;
}

const EMPTY: AgentVerdict = { findings: [] };

/**
 * Claude Agent SDK provider.
 *
 * `outputFormat` constrains generation to the verdict schema and the SDK retries
 * on mismatch. We still re-validate with Zod: a verdict that fails validation is
 * treated as "no findings, degraded", never as a silent pass — the caller turns
 * degradation into a visible warning.
 */
export class ClaudeAgentProvider implements ReviewProvider {
  readonly name = 'claude-agent-sdk';

  constructor(
    private readonly model = process.env.GOVERNANCE_MODEL ?? 'claude-sonnet-5',
    private readonly maxTurns = 1,
  ) {}

  async review(request: ReviewRequest): Promise<ProviderResult> {
    let query: typeof import('@anthropic-ai/claude-agent-sdk').query;
    try {
      ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch (err) {
      return {
        verdict: EMPTY,
        degradedReason: `Claude Agent SDK not available: ${(err as Error).message}`,
      };
    }

    try {
      for await (const message of query({
        prompt: request.userPrompt,
        options: {
          model: this.model,
          maxTurns: this.maxTurns,
          systemPrompt: request.systemPrompt,
          // No tools: this is pure judgement over the supplied text. The agent
          // must not read the repository — it would then be reviewing files the
          // integrity job never verified.
          allowedTools: [],
          settingSources: [],
          outputFormat: {
            type: 'json_schema',
            schema: VERDICT_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      })) {
        if (message.type !== 'result') continue;

        if (message.subtype !== 'success' || message.structured_output === undefined) {
          return {
            verdict: EMPTY,
            degradedReason: `agent returned ${message.subtype} for ${request.label}`,
          };
        }

        const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const parsed = AgentVerdictSchema.safeParse(message.structured_output);
        if (!parsed.success) {
          return {
            verdict: EMPTY,
            degradedReason: `verdict failed schema validation for ${request.label}: ${parsed.error.issues
              .map((i) => i.message)
              .join('; ')}`,
          };
        }

        return {
          verdict: parsed.data,
          usage: {
            ...(usage?.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
            ...(usage?.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
            ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }),
          },
        };
      }

      return { verdict: EMPTY, degradedReason: `agent produced no result for ${request.label}` };
    } catch (err) {
      return { verdict: EMPTY, degradedReason: `agent error on ${request.label}: ${(err as Error).message}` };
    }
  }
}

/**
 * Deterministic stand-in used by tests and by `GOVERNANCE_AGENT_MODE=mock`.
 * It exercises the entire pipeline — chunking, schema validation, gating,
 * reporting — without an API key, which is what makes the gate testable in CI.
 */
export class MockProvider implements ReviewProvider {
  readonly name = 'mock';

  constructor(private readonly canned: AgentVerdict = EMPTY) {}

  async review(_request: ReviewRequest): Promise<ProviderResult> {
    return { verdict: AgentVerdictSchema.parse(this.canned) };
  }
}

export function selectProvider(): ReviewProvider {
  if (process.env.GOVERNANCE_AGENT_MODE === 'mock') {
    const canned = process.env.GOVERNANCE_MOCK_VERDICT;
    return new MockProvider(canned ? (JSON.parse(canned) as AgentVerdict) : EMPTY);
  }
  return new ClaudeAgentProvider();
}
