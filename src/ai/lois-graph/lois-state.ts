import type { LangGraphModule } from './langgraph-loader';
import type { LoisWorker } from '../lois-workers';
import type { LoisPageContextInput } from '../ai-page-context';
import type { LoisThreadMemory } from '../lois-thread-memory';
import { emptyThreadMemory } from '../lois-thread-memory';

export type LoisChatTurn = { role: 'user' | 'assistant' | 'system'; content: string };

export type LoisHitlDecision = {
  applied?: boolean;
  cancelled?: boolean;
  followUp?: boolean;
};

export type LoisGraphStateValues = {
  messages: LoisChatTurn[];
  schoolId: string;
  userId: string;
  role: string;
  pageFocus: LoisPageContextInput | null;
  allowedWorkers: LoisWorker[];
  activeWorker: LoisWorker | null;
  insightId: string | null;
  planId: string | null;
  planKind: 'TIMETABLE' | 'SCHEME' | null;
  lastAssistant: string;
  visitedWorkers: LoisWorker[];
  plannedWorkers: LoisWorker[];
  threadMemory: LoisThreadMemory | null;
  /** School clause of a mixed message. Workers answer only this when set. */
  focusAsk: string | null;
  hops: number;
  hitl: LoisHitlDecision | null;
};

export function makeLoisStateAnnotation(lg: LangGraphModule) {
  const { Annotation } = lg;
  return Annotation.Root({
    messages: Annotation<LoisChatTurn[]>({
      reducer: (_left: LoisChatTurn[], right: LoisChatTurn[]) => right,
      default: () => [],
    }),
    schoolId: Annotation<string>(),
    userId: Annotation<string>(),
    role: Annotation<string>(),
    pageFocus: Annotation<LoisPageContextInput | null>(),
    allowedWorkers: Annotation<LoisWorker[]>(),
    activeWorker: Annotation<LoisWorker | null>(),
    insightId: Annotation<string | null>(),
    planId: Annotation<string | null>(),
    planKind: Annotation<'TIMETABLE' | 'SCHEME' | null>(),
    lastAssistant: Annotation<string>(),
    visitedWorkers: Annotation<LoisWorker[]>({
      reducer: (_left: LoisWorker[], right: LoisWorker[]) => right,
      default: () => [],
    }),
    plannedWorkers: Annotation<LoisWorker[]>({
      reducer: (_left: LoisWorker[], right: LoisWorker[]) => right,
      default: () => [],
    }),
    threadMemory: Annotation<LoisThreadMemory | null>({
      reducer: (_left: LoisThreadMemory | null, right: LoisThreadMemory | null) => right,
      default: () => emptyThreadMemory(),
    }),
    focusAsk: Annotation<string | null>({
      reducer: (_left: string | null, right: string | null) => right,
      default: () => null,
    }),
    hops: Annotation<number>(),
    hitl: Annotation<LoisHitlDecision | null>(),
  });
}
