/**
 * Optional Langfuse tracing. Every review chunk emits one event so that false
 * positives can be analysed per rule, per repo, over time — that analysis is how
 * the rubric gets tuned.
 *
 * Fire-and-forget by design: observability must never fail a PR check. If
 * Langfuse is unreachable or unconfigured, we log locally and move on.
 */

export interface TraceEvent {
  name: string;
  label: string;
  tier: string;
  governanceVersion: string;
  provider: string;
  findings: number;
  degradedReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export async function trace(event: TraceEvent): Promise<void> {
  const host = process.env.LANGFUSE_HOST;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (process.env.GOVERNANCE_TRACE_STDOUT === '1') {
    console.error(`[trace] ${JSON.stringify(event)}`);
  }

  if (!host || !publicKey || !secretKey) return;

  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const body = {
    batch: [
      {
        id: `${event.label}-${event.findings}-${event.governanceVersion}`,
        type: 'span-create',
        body: {
          name: event.name,
          metadata: event,
        },
      },
    ],
  };

  try {
    const response = await fetch(`${host.replace(/\/$/, '')}/api/public/ingestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.error(`[trace] langfuse responded ${response.status}`);
    }
  } catch (err) {
    console.error(`[trace] langfuse unreachable: ${(err as Error).message}`);
  }
}
