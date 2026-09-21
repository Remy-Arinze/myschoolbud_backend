/**
 * Shared Beulah access-QA profiles (same school as the owner JWT).
 * Seed + mint both import this so emails and files stay in lockstep.
 */
export const BEULAH_SCHOOL_ID =
  process.env.E2E_BEULAH_SCHOOL_ID || 'cmtjyqd0c0006ampdqq4ce7qy';

export type BeulahAccessKey = 'bursar' | 'empty' | 'vp';

export type BeulahAccessProfile = {
  key: BeulahAccessKey;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** Display title only. Authority is `accessTier`. */
  role: string;
  /** Every QA profile here is deliberately STAFF — they must be judged by rows. */
  accessTier: 'PRINCIPAL' | 'STAFF';
  schoolType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | null;
  /** Empty array means zero staffPermission rows (not the API all-READ fallback). */
  permissions: Array<{ resource: string; type: 'READ' | 'WRITE' | 'ADMIN' }>;
  authFile: string;
};

export const BEULAH_ACCESS_PROFILES: BeulahAccessProfile[] = [
  {
    key: 'bursar',
    email: process.env.E2E_BEULAH_BURSAR_EMAIL || 'remyarinze+beubursar@gmail.com',
    firstName: 'Beulah',
    lastName: 'Bursar',
    phone: '2348090100001',
    role: 'bursar',
    accessTier: 'STAFF',
    schoolType: null,
    permissions: [{ resource: 'SETTINGS', type: 'READ' }],
    authFile: 'beulah-bursar.json',
  },
  {
    key: 'empty',
    email: process.env.E2E_BEULAH_EMPTY_EMAIL || 'remyarinze+beuempty@gmail.com',
    firstName: 'Beulah',
    lastName: 'Clerk',
    phone: '2348090100002',
    role: 'administrator',
    accessTier: 'STAFF',
    schoolType: null,
    permissions: [],
    authFile: 'beulah-empty.json',
  },
  {
    key: 'vp',
    email: process.env.E2E_BEULAH_VP_EMAIL || 'remyarinze+beuvp@gmail.com',
    firstName: 'Beulah',
    lastName: 'Vice',
    phone: '2348090100003',
    role: 'vice_principal',
    accessTier: 'STAFF',
    schoolType: 'PRIMARY',
    permissions: [
      { resource: 'CLASSES', type: 'READ' },
      { resource: 'GRADES', type: 'READ' },
      { resource: 'CURRICULUM', type: 'READ' },
      { resource: 'TIMETABLES', type: 'READ' },
    ],
    authFile: 'beulah-vp.json',
  },
];
