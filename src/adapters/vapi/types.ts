/**
 * Vapi webhook shapes.
 *
 * Deliberately loose, same reasoning as `adapters/razorpay/types.ts`: Vapi's
 * exact wire format for a given message type is not something to hard-code a
 * single guess of and hope. Every field here is optional, and `parseEnvelope`
 * tries several plausible locations for the ones that matter (the message
 * type, the call id, the tool-call list) rather than trusting one shape. A
 * payload this cannot make sense of is reported as `unrecognised`, never
 * thrown away — see `webhook.ts`.
 */

export type RawVapiPayload = Record<string, unknown>;

export interface VapiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface VapiCallRef {
  readonly id: string | null;
  /** Whatever we set on `createCall`'s `metadata`, e.g. `{ caseId, voiceCallId }`. */
  readonly metadata: Record<string, unknown>;
}

export type ParsedVapiMessage =
  | { readonly type: 'status-update'; readonly call: VapiCallRef; readonly status: string | null }
  | { readonly type: 'tool-calls'; readonly call: VapiCallRef; readonly toolCalls: readonly VapiToolCall[] }
  | {
      readonly type: 'end-of-call-report';
      readonly call: VapiCallRef;
      readonly transcript: unknown;
      readonly recordingUrl: string | null;
      readonly endedReason: string | null;
      readonly durationSeconds: number | null;
    }
  | { readonly type: 'unrecognised'; readonly rawType: string | null; readonly raw: RawVapiPayload };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Some payloads wrap everything in a `message` field, some don't — accept both. */
function unwrap(payload: RawVapiPayload): Record<string, unknown> {
  const inner = obj(payload.message);
  return Object.keys(inner).length > 0 ? inner : payload;
}

function parseCallRef(body: Record<string, unknown>): VapiCallRef {
  const call = obj(body.call);
  const id = str(call.id) ?? str(body.callId);
  const metadata = obj(call.metadata) ?? obj(body.metadata);
  return { id, metadata };
}

/** Arguments sometimes arrive as a JSON string, sometimes already parsed. */
function parseToolArguments(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return obj(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return obj(v);
}

function parseToolCalls(body: Record<string, unknown>): VapiToolCall[] {
  const list =
    (Array.isArray(body.toolCallList) && body.toolCallList) ||
    (Array.isArray(body.toolCalls) && body.toolCalls) ||
    (Array.isArray(body['tool_calls']) && body['tool_calls']) ||
    [];

  return list
    .map((entry) => {
      const e = obj(entry);
      const fn = obj(e.function);
      const id = str(e.id) ?? str(e['toolCallId']);
      const name = str(fn.name) ?? str(e.name);
      if (!id || !name) return null;
      return { id, name, arguments: parseToolArguments(fn.arguments ?? e.arguments) };
    })
    .filter((c): c is VapiToolCall => c !== null);
}

export function parseEnvelope(payload: RawVapiPayload): ParsedVapiMessage {
  const body = unwrap(payload);
  const type = str(body.type);
  const call = parseCallRef(body);

  if (type === 'status-update') {
    return { type: 'status-update', call, status: str(body.status) };
  }

  if (type === 'tool-calls' || type === 'function-call') {
    return { type: 'tool-calls', call, toolCalls: parseToolCalls(body) };
  }

  if (type === 'end-of-call-report') {
    const artifact = obj(body.artifact);
    return {
      type: 'end-of-call-report',
      call,
      transcript: body.transcript ?? artifact.transcript ?? null,
      recordingUrl:
        str(body.recordingUrl) ?? str(artifact.recordingUrl) ?? str(obj(artifact.recording).stereoUrl),
      endedReason: str(body.endedReason),
      durationSeconds: num(body.durationSeconds) ?? num(body.duration),
    };
  }

  return { type: 'unrecognised', rawType: type, raw: payload };
}
