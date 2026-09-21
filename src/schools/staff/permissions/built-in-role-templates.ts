import { PermissionResource, PermissionType } from '@prisma/client';

const { READ, WRITE, ADMIN } = PermissionType;
const R = PermissionResource;

export type BuiltInRoleTemplate = {
  /** Stable handle — seeding keys off this, so names can be reworded safely. */
  slug: string;
  name: string;
  description: string;
  /** Prefills the job title field. Still only a label. */
  suggestedRole: string;
  permissions: Array<{ resource: PermissionResource; type: PermissionType }>;
};

/**
 * The access bundles every school starts with.
 *
 * These exist because "which boxes do I tick for a bursar?" is not a question a
 * school should have to answer from scratch. Each one is deliberately narrow —
 * a starting point that can be widened, never a shortcut to full access. None
 * of them touch SUBSCRIPTIONS, and only Deputy Head grants STAFF:ADMIN, which
 * is what lets someone invite and remove colleagues.
 *
 * WRITE implies READ at the guard, but rows are listed explicitly so the picker
 * shows the school exactly what it is granting.
 */
export const BUILT_IN_ROLE_TEMPLATES: BuiltInRoleTemplate[] = [
  {
    slug: 'bursar',
    name: 'Bursar',
    description: 'Fees, admissions paperwork and the student register — no academics.',
    suggestedRole: 'Bursar',
    permissions: [
      { resource: R.OVERVIEW, type: READ },
      { resource: R.STUDENTS, type: READ },
      { resource: R.ADMISSIONS, type: READ },
      { resource: R.ADMISSIONS, type: WRITE },
      { resource: R.TRANSFERS, type: READ },
      { resource: R.SETTINGS, type: READ },
    ],
  },
  {
    slug: 'academic-head',
    name: 'Academic Head',
    description: 'Runs teaching and learning: classes, subjects, curriculum, grades.',
    suggestedRole: 'Head of Academics',
    permissions: [
      { resource: R.OVERVIEW, type: READ },
      { resource: R.CLASSES, type: READ },
      { resource: R.CLASSES, type: WRITE },
      { resource: R.SUBJECTS, type: READ },
      { resource: R.SUBJECTS, type: WRITE },
      { resource: R.CURRICULUM, type: READ },
      { resource: R.CURRICULUM, type: WRITE },
      { resource: R.SCHEME_OF_WORK, type: READ },
      { resource: R.SCHEME_OF_WORK, type: WRITE },
      { resource: R.GRADES, type: READ },
      { resource: R.GRADES, type: WRITE },
      { resource: R.TIMETABLES, type: READ },
      { resource: R.STUDENTS, type: READ },
      { resource: R.STAFF, type: READ },
    ],
  },
  {
    slug: 'exams-officer',
    name: 'Exams Officer',
    description: 'Timetables, exam scheduling and results entry.',
    suggestedRole: 'Exams Officer',
    permissions: [
      { resource: R.OVERVIEW, type: READ },
      { resource: R.TIMETABLES, type: READ },
      { resource: R.TIMETABLES, type: WRITE },
      { resource: R.GRADES, type: READ },
      { resource: R.GRADES, type: WRITE },
      { resource: R.CALENDAR, type: READ },
      { resource: R.CLASSES, type: READ },
      { resource: R.SUBJECTS, type: READ },
      { resource: R.STUDENTS, type: READ },
    ],
  },
  {
    slug: 'registrar',
    name: 'Registrar',
    description: 'Admissions, enrolment and transfers, end to end.',
    suggestedRole: 'Registrar',
    permissions: [
      { resource: R.OVERVIEW, type: READ },
      { resource: R.STUDENTS, type: READ },
      { resource: R.STUDENTS, type: WRITE },
      { resource: R.ADMISSIONS, type: READ },
      { resource: R.ADMISSIONS, type: WRITE },
      { resource: R.TRANSFERS, type: READ },
      { resource: R.TRANSFERS, type: WRITE },
      { resource: R.CLASSES, type: READ },
      { resource: R.SESSIONS, type: READ },
    ],
  },
  {
    slug: 'front-desk',
    name: 'Front Desk',
    description: 'Look-up only: who is enrolled, who teaches what, what is on today.',
    suggestedRole: 'Administrator',
    permissions: [
      { resource: R.OVERVIEW, type: READ },
      { resource: R.STUDENTS, type: READ },
      { resource: R.STAFF, type: READ },
      { resource: R.CLASSES, type: READ },
      { resource: R.CALENDAR, type: READ },
      { resource: R.EVENTS, type: READ },
      { resource: R.TIMETABLES, type: READ },
    ],
  },
  {
    slug: 'deputy-head',
    name: 'Deputy Head',
    description:
      'Broad oversight across the school, including inviting and removing staff. ' +
      'Stops short of billing.',
    suggestedRole: 'Vice Principal',
    permissions: [
      { resource: R.OVERVIEW, type: READ },
      { resource: R.ANALYTICS, type: READ },
      { resource: R.STUDENTS, type: READ },
      { resource: R.STUDENTS, type: WRITE },
      { resource: R.STAFF, type: READ },
      { resource: R.STAFF, type: WRITE },
      { resource: R.STAFF, type: ADMIN },
      { resource: R.CLASSES, type: READ },
      { resource: R.CLASSES, type: WRITE },
      { resource: R.SUBJECTS, type: READ },
      { resource: R.SUBJECTS, type: WRITE },
      { resource: R.CURRICULUM, type: READ },
      { resource: R.SCHEME_OF_WORK, type: READ },
      { resource: R.GRADES, type: READ },
      { resource: R.GRADES, type: WRITE },
      { resource: R.TIMETABLES, type: READ },
      { resource: R.TIMETABLES, type: WRITE },
      { resource: R.CALENDAR, type: READ },
      { resource: R.CALENDAR, type: WRITE },
      { resource: R.ADMISSIONS, type: READ },
      { resource: R.EVENTS, type: READ },
      { resource: R.SETTINGS, type: READ },
    ],
  },
];
