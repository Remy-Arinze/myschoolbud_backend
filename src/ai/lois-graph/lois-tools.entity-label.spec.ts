import { toolEntityLabel } from './lois-tool-entity';

describe('toolEntityLabel', () => {
  it('uses classLabel for timetable proposals', () => {
    expect(
      toolEntityLabel('propose_timetable', { classQuery: 'JSS 1 B' }, { classLabel: 'JSS 1 C' }),
    ).toBe('JSS 1 C');
  });

  it('falls back to classQuery before the tool returns', () => {
    expect(toolEntityLabel('inspect_scheduling_context', { classQuery: 'JSS 1 B' })).toBe('JSS 1 B');
  });

  it('joins topic and grade for generated quizzes', () => {
    expect(
      toolEntityLabel(
        'generate_quiz',
        { topic: 'Fractions', subject: 'Mathematics', gradeLevel: 'JSS 1' },
        { title: 'Fractions quiz' },
      ),
    ).toBe('Fractions quiz · JSS 1');
  });

  it('includes day on timetable lookups', () => {
    expect(
      toolEntityLabel('get_timetable', { classQuery: 'JSS 1 B', day: 'Thursday' }, {
        className: 'JSS 1 B',
        dayOfWeek: 'THURSDAY',
      }),
    ).toBe('JSS 1 B · THURSDAY');
  });
});
