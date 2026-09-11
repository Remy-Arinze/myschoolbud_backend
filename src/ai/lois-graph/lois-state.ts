import type { LangGraphModule } from './langgraph-loader';
import type { LoisWorker } from '../lois-workers';
import type { LoisPageContextInput } from '../ai-page-context';

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
    hops: Annotation<number>(),
    hitl: Annotation<LoisHitlDecision | null>(),
  });
}
