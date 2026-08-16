import { z } from 'zod';
import { FindingSchema } from '@shashiladev-heshan/policy-core';

/**
 * What the agent is allowed to say. Two layers on purpose:
 *
 *   1. `VERDICT_JSON_SCHEMA` is handed to the SDK as `outputFormat`, so the model
 *      is constrained at generation time and retried by the SDK on mismatch.
 *   2. `AgentVerdictSchema` re-validates the result before anything reads it.
 *
 * The second layer is not redundant. The gate must never consume a shape it has
 * not checked itself, whatever the SDK guarantees.
 */
export const AgentVerdictSchema = z.object({
  findings: z.array(FindingSchema),
  /** The agent's own summary. Advisory text only — it does not set the gate. */
  notes: z.string().optional(),
});
export type AgentVerdict = z.infer<typeof AgentVerdictSchema>;

export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ruleId', 'severity', 'file', 'rationale'],
        properties: {
          ruleId: {
            type: 'string',
            description: 'Exact rule id from the supplied policy. Never invent one.',
          },
          severity: { type: 'string', enum: ['info', 'warn', 'error'] },
          file: { type: 'string', description: 'Path exactly as it appears in the diff' },
          line: { type: 'number', description: 'Line number in the new file, if known' },
          rationale: {
            type: 'string',
            description:
              'Why this violates the rule, in terms of the skill. Teach the pattern; do not merely reject.',
          },
          suggestedFix: {
            type: 'string',
            description: 'Replacement code for the cited lines, if a concrete fix is obvious',
          },
        },
      },
    },
    notes: { type: 'string' },
  },
  required: ['findings'],
} as const;

/** The full artefact written to disk — verdict plus everything needed to audit it. */
export interface ReviewOutput {
  verdict: 'pass' | 'warn' | 'block';
  tier: string;
  governanceVersion: string;
  blocking: AgentVerdict['findings'];
  warnings: AgentVerdict['findings'];
  dropped: AgentVerdict['findings'];
  unknownRules: AgentVerdict['findings'];
  stats: {
    filesReviewed: number;
    filesSkipped: number;
    chunks: number;
    degraded: boolean;
    degradedReason?: string;
  };
  rubric: { skills: string[]; activeRules: string[] };
}
