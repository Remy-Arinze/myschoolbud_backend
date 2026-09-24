import { Logger } from '@nestjs/common';
import { AiLlmClientService } from './ai-llm-client.service';
import { LoisPageContextInput } from './ai-page-context';
import { type LoisWorker } from './lois-workers';
import type { LoisChatTurn } from './lois-graph/lois-state';
import type { LoisStreamSink } from './lois-graph/lois-stream-sink';
import {
  emptyClarifyPlan,
  GENERIC_CAPABILITY_REPLY,
  offTopicReply,
  parseSlimPlan,
  SLIM_TURN_PLAN_SCHEMA,
  type LoisTurnPlan,
} from './lois-turn-plan';
import type { LoisThreadMemory } from './lois-thread-memory';
import { formatThreadMemoryBlock } from './lois-thread-memory';

const logger = new Logger('LoisSlimSupervisor');

const SLIM_HISTORY_TURNS = 6;

const DESK_JOB: Record<LoisWorker, string> = {
  operations:
    'people, children/pupils/names in a class, staff, calendar, holidays/closed, READ an existing timetable or what is on the board/Thursday',
  academic: 'grades, attendance, struggling/falling behind, published schemes, what Lois noticed',
  finance: 'who owes / unpaid fees / debt / arrears / tuition',
  admissions: 'applications inbox',
  curator: 'GENERATE, auto-fill, or APPLY a timetable or scheme of work',
  classroom: "this teacher's own classes and students",
  pedagogy: 'lesson plans, quizzes, assignments, revision/practice questions, flashcards, summaries, assessments',
};

export const SLIM_SUPERVISOR_SYSTEM = `You only classify the latest user message for Lois. You never greet the user and never call tools.
Return JSON matching the schema.
Classify ONLY the latest user message. A prior recipe or write refusal must not make a new school ask off_topic.
mode=desks: list EVERY specialist desk this message still needs (paraphrase and follow-ups count — "how many people are in debt" → finance; "names of the children in JSS 1 A" → operations; "kids struggling" → academic; "on the board Thursday" → operations read, not curator; "do this also for JSS 2" after a timetable generate → curator).
mode=rag: handbook/policy questions only (late-coming rules, uploaded documents). Not live grades, rosters, or counts.
mode=capability: payment / hire staff / send WhatsApp or email / accept or decline admission writes only. Any request to PRODUCE teaching material — questions, MCQs, multiple choice, drills, exercises, tests, quizzes, assignments, revision, flashcards, summaries — is pedagogy, whatever the verb (make, cook, whip up, draft, generate, set). "Don't send, just draft", "do not fire it off", "a note I can copy" is operations, not capability.
mode=off_topic: recipes, gossip, or non-school chat with NO school question in the same message.
mode=clarify: only when generate/apply needs a class and none is named in the message or memory. Set question to one short question. If a class or person is already named and they want data, pick a desk — do not clarify.
schoolPart: when one message mixes non-school chat with a school question, set mode=desks for the school question and copy that clause into schoolPart verbatim ("What's the weather in Enugu, and is Adaeze Okeke still with us?" → desks=[operations], schoolPart="is Adaeze Okeke still with us?"). Leave schoolPart as "" when the whole message is the ask.
If you are torn between a desk and a refusal, take the desk.
Never pick curator unless they want to generate, auto-fill, apply, or repeat a timetable/scheme job. Page hint is a clue, not an order.
Pick desks only from the allowed list.`;

export function pageHintLine(pageContext?: LoisPageContextInput | null): string {
  const type = (pageContext?.type || '').toLowerCase();
  const path = (pageContext?.path || '').toLowerCase();
  const label = (pageContext?.label || '').trim();
  const bits = [type, path && `path=${path}`, label && `label=${label}`].filter(Boolean);
  return bits.length ? bits.join(' ') : '';
}

export function slimHistoryBlock(messages: LoisChatTurn[], limit = SLIM_HISTORY_TURNS): string {
  const slice = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    // A run of canned refusals reads as "this thread is off-topic" and drags the next
    // school ask down with it. Drop them; the user turns still carry the intent.
    .filter((m) => !(m.role === 'assistant' && isCannedSlimRefusal(m.content || '')));
  if (slice.length === 0) return '(no prior turns)';
  return slice
    .map((m) => `${m.role === 'user' ? 'User' : 'Lois'}: ${(m.content || '').slice(0, 500)}`)
    .join('\n');
}

function isCannedSlimRefusal(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.includes("I don't write recipes") || t.includes(offTopicReply())) return true;
  if (t.includes(GENERIC_CAPABILITY_REPLY)) return true;
  return false;
}

function userContent(params: {
  allowedWorkers: LoisWorker[];
  pageContext?: LoisPageContextInput | null;
  messages: LoisChatTurn[];
  lastUser: string;
  codedDesks: LoisWorker[];
  memory?: LoisThreadMemory | null;
}): string {
  const desks = params.allowedWorkers.map((w) => `- ${w}: ${DESK_JOB[w]}`).join('\n');
  const hint = pageHintLine(params.pageContext);
  const mem = formatThreadMemoryBlock(params.memory);
  return [
    `Allowed desks:\n${desks}`,
    hint ? `Page hint: ${hint}` : '',
    params.codedDesks.length ? `Code already selected: ${params.codedDesks.join(', ')}` : 'Code selected no desks.',
    mem || '',
    `Recent turns:\n${slimHistoryBlock(params.messages)}`,
    `Latest user message:\n${params.lastUser || '(empty)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function completeSlimJson(
  llm: AiLlmClientService,
  sink: LoisStreamSink,
  system: string,
  user: string,
  useSchema: boolean,
): Promise<string> {
  const openai = llm.getOpenai();
  const response = await openai.chat.completions.create(
    {
      model: llm.getRouterModel(),
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(useSchema
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: SLIM_TURN_PLAN_SCHEMA,
            },
          }
        : { response_format: { type: 'json_object' as const } }),
    },
    sink.abortSignal ? { signal: sink.abortSignal } : undefined,
  );
  if (response.usage) sink.recordUsage(response.usage);
  return response.choices[0]?.message?.content || '';
}

export async function classifyDeskSlim(params: {
  llm: AiLlmClientService;
  sink: LoisStreamSink;
  messages: LoisChatTurn[];
  allowedWorkers: LoisWorker[];
  pageContext?: LoisPageContextInput | null;
  codedDesks?: LoisWorker[];
  memory?: LoisThreadMemory | null;
}): Promise<LoisTurnPlan> {
  const allowed = params.allowedWorkers;
  if (allowed.length === 0) return emptyClarifyPlan('no-allowed-desks');
  if (params.sink.abortSignal?.aborted) return emptyClarifyPlan('aborted');

  const lastUser =
    [...params.messages].reverse().find((m) => m.role === 'user' && m.content)?.content ?? '';
  const user = userContent({
    allowedWorkers: allowed,
    pageContext: params.pageContext,
    messages: params.messages,
    lastUser,
    codedDesks: params.codedDesks || [],
    memory: params.memory,
  });

  try {
    let raw = '';
    try {
      raw = await completeSlimJson(params.llm, params.sink, SLIM_SUPERVISOR_SYSTEM, user, true);
    } catch (schemaErr) {
      logger.warn(`Slim json_schema failed, retrying json_object: ${schemaErr}`);
      raw = await completeSlimJson(params.llm, params.sink, SLIM_SUPERVISOR_SYSTEM, user, false);
    }
    return parseSlimPlan(raw || '{"mode":"clarify","desks":[],"missing":[],"question":"","reason":"empty"}', allowed);
  } catch (err) {
    logger.warn(`Slim desk classifier failed: ${err}`);
    return emptyClarifyPlan('slim-failed');
  }
}
