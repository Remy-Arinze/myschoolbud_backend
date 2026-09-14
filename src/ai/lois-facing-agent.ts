import { AiLlmClientService } from './ai-llm-client.service';
import { needsFacingRewrite, sanitizeUserFacingText, scrubBackendWording } from './lois-reply-sanitize';
import type { LoisChatTurn, LoisGraphStateValues } from './lois-graph/lois-state';
import type { LoisStreamSink } from './lois-graph/lois-stream-sink';

export const FACING_SYSTEM = `You are Lois. Rewrite the draft as the final chat reply a person at a school will read.

Keep every fact, name, date, amount, and count. Do not invent or drop them.
Stay Lois — first person, same meaning.
Never include backend or system wording: role enums, snake_case keys, camelCase field names, tool names, JSON, API paths, database ids, permission keys.
Use ordinary phrases (school owner, school administrator, teacher, student). Never write SCHOOL_ADMIN, SUPER_ADMIN, school_owner, or similar system labels.
Return only the reply. No preamble.`;

function messagesThroughLastUser(messages: LoisChatTurn[]): LoisChatTurn[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return messages.filter((m) => m.role === 'user');
  return messages.slice(0, lastUser + 1);
}

function lastUserText(messages: LoisChatTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && messages[i].content) return messages[i].content;
  }
  return '';
}

function speak(sink: LoisStreamSink, piece: string): boolean {
  if (!piece) return true;
  if (!sink.addEstimated(piece.length)) return false;
  sink.send('token', { token: piece });
  return true;
}

function facingState(
  state: Pick<LoisGraphStateValues, 'messages' | 'lastAssistant' | 'planId'>,
  facing: string,
): Partial<LoisGraphStateValues> {
  return {
    lastAssistant: facing,
    messages: [...messagesThroughLastUser(state.messages), { role: 'assistant', content: facing }],
    activeWorker: null,
  };
}

/** Copy-desk: skip the LLM when the draft is already school-facing; otherwise rewrite and stream. */
export async function runLoisFacingNode(params: {
  state: Pick<LoisGraphStateValues, 'messages' | 'lastAssistant' | 'planId'>;
  llm: AiLlmClientService;
  sink: LoisStreamSink;
}): Promise<Partial<LoisGraphStateValues>> {
  const { state, llm, sink } = params;
  const draft = (state.lastAssistant || '').trim();
  if (!draft) {
    return { lastAssistant: '', activeWorker: null };
  }

  const cleaned = sanitizeUserFacingText(draft);
  if (!needsFacingRewrite(draft) || sink.abortSignal?.aborted) {
    speak(sink, cleaned);
    return facingState(state, cleaned);
  }

  let rewritten = '';
  try {
    const openai = llm.getOpenai();
    const stream = await openai.chat.completions.create(
      {
        model: llm.getModel(),
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: FACING_SYSTEM },
          {
            role: 'user',
            content: `The user asked:\n${lastUserText(state.messages) || '(no question)'}\n\nDraft to rewrite:\n${draft}`,
          },
        ],
      },
      sink.abortSignal ? { signal: sink.abortSignal } : undefined,
    );

    for await (const chunk of stream) {
      if (sink.abortSignal?.aborted) break;
      if (chunk.usage) sink.recordUsage(chunk.usage);
      const piece = scrubBackendWording(chunk.choices?.[0]?.delta?.content || '');
      if (!piece) continue;
      rewritten += piece;
      if (!speak(sink, piece)) break;
    }
  } catch {
    rewritten = '';
  }

  const facing = sanitizeUserFacingText((rewritten || draft).trim() || draft);
  if (!rewritten && facing) {
    speak(sink, facing);
  }

  return facingState(state, facing);
}
