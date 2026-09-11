/** Client hint for the record currently on screen. Always re-verified server-side. */

export type LoisPageContextInput = {
  type?: string;
  schoolId?: string;
  studentId?: string;
  classId?: string;
  classArmId?: string;
  teacherId?: string;
  schemeId?: string;
  assessmentId?: string;
  weekNumber?: number;
  label?: string;
  path?: string;
  /** Briefing “Ask about this” — start Academic with this insight in context. */
  insightId?: string;
};
