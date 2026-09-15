import { isLoisWorker, type LoisWorker } from './lois-workers';

export type LoisMemoryArtifact = 'timetable' | 'scheme' | 'quiz' | 'other';

export type LoisLastJob = {
  desk: LoisWorker;
  tool: string;
  artifact: LoisMemoryArtifact;
};

export type LoisMemoryPerson = {
  name: string;
  kind: 'student' | 'staff' | 'unknown';
};

export type LoisPendingClarify = {
  slot: string;
  question: string;
  resumeDesks: LoisWorker[];
};

export type LoisThreadMemory = {
  lastJob: LoisLastJob | null;
  classes: string[];
  people: LoisMemoryPerson[];
  range: string | null;
  pendingClarify: LoisPendingClarify | null;
};

const MAX_CLASSES = 8;
const MAX_PEOPLE = 8;

export function emptyThreadMemory(): LoisThreadMemory {
  return {
    lastJob: null,
    classes: [],
    people: [],
    range: null,
    pendingClarify: null,
  };
}

export function parseThreadMemory(raw: unknown): LoisThreadMemory {
  const base = emptyThreadMemory();
  if (!raw || typeof raw !== 'object') return base;
  const rec = raw as Record<string, unknown>;
  const job = rec.lastJob && typeof rec.lastJob === 'object' ? (rec.lastJob as Record<string, unknown>) : null;
  if (job && typeof job.desk === 'string' && isLoisWorker(job.desk) && typeof job.tool === 'string') {
    const artifact =
      job.artifact === 'timetable' || job.artifact === 'scheme' || job.artifact === 'quiz' ? job.artifact : 'other';
    base.lastJob = { desk: job.desk, tool: job.tool, artifact };
  }
  if (Array.isArray(rec.classes)) {
    base.classes = rec.classes
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c) => c.trim())
      .slice(0, MAX_CLASSES);
  }
  if (Array.isArray(rec.people)) {
    base.people = rec.people
      .map((p) => {
        if (!p || typeof p !== 'object') return null;
        const row = p as Record<string, unknown>;
        if (typeof row.name !== 'string' || !row.name.trim()) return null;
        const kind = row.kind === 'student' || row.kind === 'staff' ? row.kind : 'unknown';
        return { name: row.name.trim(), kind };
      })
      .filter((p): p is LoisMemoryPerson => !!p)
      .slice(0, MAX_PEOPLE);
  }
  if (typeof rec.range === 'string' && rec.range.trim()) base.range = rec.range.trim();
  const clarify = rec.pendingClarify && typeof rec.pendingClarify === 'object' ? (rec.pendingClarify as Record<string, unknown>) : null;
  if (
    clarify &&
    typeof clarify.slot === 'string' &&
    typeof clarify.question === 'string' &&
    Array.isArray(clarify.resumeDesks)
  ) {
    const resumeDesks = clarify.resumeDesks.filter((d): d is LoisWorker => typeof d === 'string' && isLoisWorker(d));
    if (resumeDesks.length) {
      base.pendingClarify = {
        slot: clarify.slot,
        question: clarify.question,
        resumeDesks,
      };
    }
  }
  return base;
}

function pushUnique(list: string[], value: string | undefined, cap: number): void {
  const v = (value || '').trim();
  if (!v) return;
  const key = v.toLowerCase();
  if (list.some((x) => x.toLowerCase() === key)) return;
  list.unshift(v);
  if (list.length > cap) list.length = cap;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function jobFromTool(toolName: string): LoisLastJob | null {
  if (toolName === 'propose_timetable') return { desk: 'curator', tool: toolName, artifact: 'timetable' };
  if (toolName === 'propose_scheme') return { desk: 'curator', tool: toolName, artifact: 'scheme' };
  if (toolName === 'apply_pending_plans') return { desk: 'curator', tool: toolName, artifact: 'timetable' };
  if (toolName === 'list_fee_debtors') return { desk: 'finance', tool: toolName, artifact: 'other' };
  if (toolName === 'list_admissions') return { desk: 'admissions', tool: toolName, artifact: 'other' };
  if (toolName === 'generate_quiz' || toolName === 'generate_lesson_plan') {
    return { desk: 'pedagogy', tool: toolName, artifact: toolName === 'generate_quiz' ? 'quiz' : 'other' };
  }
  if (toolName === 'get_attendance_summary' || toolName === 'list_lois_insights' || toolName === 'get_class_performance') {
    return { desk: 'academic', tool: toolName, artifact: 'other' };
  }
  if (toolName === 'list_students' || toolName === 'list_staff' || toolName === 'get_calendar') {
    return { desk: 'operations', tool: toolName, artifact: 'other' };
  }
  return null;
}

/** Merge tool_start / tool_result cards into thread memory. Ignores model prose. */
export function applyToolEventsToMemory(memory: LoisThreadMemory, toolEvents: unknown[]): LoisThreadMemory {
  const next: LoisThreadMemory = {
    lastJob: memory.lastJob,
    classes: [...memory.classes],
    people: [...memory.people],
    range: memory.range,
    pendingClarify: memory.pendingClarify,
  };

  for (const event of toolEvents) {
    const rec = asRecord(event);
    if (!rec) continue;
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type !== 'tool_result' && type !== 'tool_start') continue;
    const toolName = typeof rec.toolName === 'string' ? rec.toolName : '';
    if (!toolName) continue;
    const job = jobFromTool(toolName);
    if (job) next.lastJob = job;

    const args = asRecord(rec.args) || {};
    const result = asRecord(rec.result) || {};
    const label = typeof rec.entityLabel === 'string' ? rec.entityLabel : '';
    const classQuery = typeof args.classQuery === 'string' ? args.classQuery : '';
    const classLabel =
      (typeof result.classLabel === 'string' && result.classLabel) ||
      (typeof result.className === 'string' && result.className) ||
      classQuery ||
      (label && /jss|ss|primary|year|form|arm/i.test(label) ? label.split('·')[0].trim() : '');
    if (classLabel && toolName !== 'list_staff') pushUnique(next.classes, classLabel, MAX_CLASSES);

    if (typeof args.range === 'string' && args.range.trim()) next.range = args.range.trim();

    if (toolName === 'list_students' || toolName === 'get_student_overview' || toolName === 'get_guardians') {
      const name =
        (typeof result.studentName === 'string' && result.studentName) ||
        (typeof args.query === 'string' && args.query) ||
        '';
      if (name && !/jss|ss\s*\d|primary/i.test(name)) {
        const existing = next.people.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
        if (existing) existing.kind = 'student';
        else next.people.unshift({ name: name.trim(), kind: 'student' });
        if (next.people.length > MAX_PEOPLE) next.people.length = MAX_PEOPLE;
      }
    }
    if (toolName === 'list_staff' || toolName === 'who_teaches') {
      const name = (typeof args.query === 'string' && args.query) || label;
      if (name && name.length < 80) {
        const existing = next.people.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
        if (existing) existing.kind = 'staff';
        else next.people.unshift({ name: name.trim(), kind: 'staff' });
        if (next.people.length > MAX_PEOPLE) next.people.length = MAX_PEOPLE;
      }
    }
  }

  return next;
}

export function formatThreadMemoryBlock(memory?: LoisThreadMemory | null): string {
  if (!memory) return '';
  const lines: string[] = [];
  if (memory.lastJob) {
    lines.push(`- last job: ${memory.lastJob.desk} ${memory.lastJob.tool} (${memory.lastJob.artifact})`);
  }
  if (memory.classes.length) lines.push(`- classes: ${memory.classes.join(', ')}`);
  if (memory.people.length) {
    lines.push(`- people: ${memory.people.map((p) => `${p.name} (${p.kind})`).join(', ')}`);
  }
  if (memory.range) lines.push(`- range: ${memory.range}`);
  if (memory.pendingClarify) {
    lines.push(`- waiting for: ${memory.pendingClarify.slot} (${memory.pendingClarify.question})`);
  }
  if (!lines.length) return '';
  return `THREAD MEMORY (resolved slots from this chat — use these; do not re-read get_timetable for a repeat generate):\n${lines.join('\n')}`;
}
