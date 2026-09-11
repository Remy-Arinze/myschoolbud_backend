function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Class, student, topic, or other entity this tool call is about — used as the card title suffix. */
export function toolEntityLabel(
  functionName: string,
  args: Record<string, unknown> = {},
  data?: unknown,
): string | undefined {
  const rec = asRecord(data) || {};
  const classish =
    nonEmptyString(rec.classLabel) ||
    nonEmptyString(rec.className) ||
    nonEmptyString(args.classQuery) ||
    nonEmptyString(args.classLabel);

  if (
    functionName === 'propose_timetable' ||
    functionName === 'propose_scheme' ||
    functionName === 'inspect_scheduling_context' ||
    functionName === 'inspect_curriculum_options' ||
    functionName === 'get_now_in_class' ||
    functionName === 'who_teaches' ||
    functionName === 'get_class_performance'
  ) {
    return classish || nonEmptyString(args.subject);
  }

  if (functionName === 'get_timetable') {
    const day = nonEmptyString(rec.dayOfWeek) || nonEmptyString(args.day);
    if (classish && day) return `${classish} · ${day}`;
    return classish || day;
  }

  if (functionName === 'get_scheme_of_work') {
    const schemes = Array.isArray(rec.schemes) ? rec.schemes : [];
    const first = asRecord(schemes[0]);
    const subject = (first && nonEmptyString(first.subject)) || nonEmptyString(args.subject);
    const level = first ? nonEmptyString(first.classLevel) : undefined;
    const bits = [level || classish, subject].filter(Boolean);
    return bits.length ? bits.join(' · ') : classish;
  }

  if (functionName === 'get_student_overview' || functionName === 'get_guardians') {
    return nonEmptyString(rec.studentName) || nonEmptyString(rec.name) || nonEmptyString(args.studentId);
  }

  if (functionName === 'list_students') {
    return classish || nonEmptyString(args.query);
  }

  if (functionName === 'list_classes') {
    return nonEmptyString(args.query) || nonEmptyString(rec.query);
  }

  if (
    functionName === 'generate_quiz' ||
    functionName === 'generate_assessment' ||
    functionName === 'generate_lesson_plan'
  ) {
    const topic =
      nonEmptyString(rec.title) || nonEmptyString(rec.topic) || nonEmptyString(args.topic);
    const subject = nonEmptyString(args.subject);
    const grade = nonEmptyString(args.gradeLevel);
    const head = topic || subject;
    if (head && grade && head !== grade) return `${head} · ${grade}`;
    return head || grade;
  }

  return (
    classish ||
    nonEmptyString(rec.title) ||
    nonEmptyString(rec.name) ||
    nonEmptyString(args.topic) ||
    nonEmptyString(args.query)
  );
}
