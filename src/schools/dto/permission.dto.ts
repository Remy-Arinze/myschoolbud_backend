import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsArray, IsString, IsOptional } from 'class-validator';

import { AdminAccessTier, PermissionResource, PermissionType } from '@prisma/client';

export { AdminAccessTier, PermissionResource, PermissionType };

/** Anything carrying an admin's access tier — the full row or a `select`ed subset. */
export type AdminWithAccessTier = {
  accessTier?: AdminAccessTier | string | null;
} | null | undefined;

/**
 * The ONLY authority check. Principal-level admins bypass the permission tables.
 *
 * Read the stored tier, never the title. A title is free text a school types, so
 * inferring authority from it meant "Head Teacher" granted everything while
 * "Headteacher" granted nothing. Tier is set deliberately via the promote/demote
 * flow and is the single thing guards, billing, and Lois consult.
 */
export function hasPrincipalAccess(admin: AdminWithAccessTier): boolean {
  return admin?.accessTier === AdminAccessTier.PRINCIPAL;
}

/**
 * Titles that read as principal-level to a human.
 *
 * NOT an authority list. Two uses only:
 *   1. the one-time accessTier backfill rule, and
 *   2. hinting in the UI ("that title sounds principal-level — grant full access?").
 *
 * For "can this person do X", use {@link hasPrincipalAccess}.
 *
 * Role naming convention: Use underscores for multi-word roles (e.g., 'school_owner', 'head_teacher')
 */
export const PRINCIPAL_ROLES = [
  'principal',
  'school_principal',
  'head_teacher',
  'headmaster',
  'headmistress',
  'school_owner',
] as const;

export type PrincipalRole = typeof PRINCIPAL_ROLES[number];

/**
 * Lowercase, trim, and convert spaces to underscores.
 * "Head Teacher" → "head_teacher". "Vice Principal" → "vice_principal".
 */
export function normalizeRoleKey(role: string): string {
  return role.toLowerCase().trim().replace(/\s+/g, '_');
}

/**
 * Canonical unique-seat title. `school_principal` is the same job as `principal`.
 */
export function canonicalizeUniqueTitle(role: string): string {
  const key = normalizeRoleKey(role);
  if (key === 'school_principal') return 'principal';
  return key;
}

/** Titles that may exist at most once per school. */
export const UNIQUE_ADMIN_TITLES = [
  'school_owner',
  'principal',
  'head_teacher',
  'headmaster',
  'headmistress',
] as const;

export type UniqueAdminTitle = (typeof UNIQUE_ADMIN_TITLES)[number];

export function isUniqueAdminTitle(role: string | null | undefined): role is UniqueAdminTitle {
  if (!role) return false;
  return (UNIQUE_ADMIN_TITLES as readonly string[]).includes(canonicalizeUniqueTitle(role));
}

export function uniqueTitleDisplayName(role: string): string {
  switch (canonicalizeUniqueTitle(role)) {
    case 'school_owner':
      return 'School Owner';
    case 'principal':
      return 'Principal';
    case 'head_teacher':
      return 'Head Teacher';
    case 'headmaster':
      return 'Headmaster';
    case 'headmistress':
      return 'Headmistress';
    default:
      return role.trim();
  }
}

export function isSchoolOwnerRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return canonicalizeUniqueTitle(role) === 'school_owner';
}

/**
 * Does this title read as principal-level?
 *
 * A HINT, not an authority check — use {@link hasPrincipalAccess} for that.
 * Matching is exact after normalisation, so near-spellings deliberately do not
 * match: that is why authority no longer depends on this.
 *
 * @example
 * isPrincipalRole('Principal') // true
 * isPrincipalRole('Head Teacher') // true
 * isPrincipalRole('school_owner') // true
 * isPrincipalRole('Vice Principal') // false
 * isPrincipalRole('Headteacher') // false — no space to normalise
 */
export function isPrincipalRole(role: string | null | undefined): boolean {
  if (!role) return false;
  const normalizedRole = normalizeRoleKey(role);
  return PRINCIPAL_ROLES.some((principalRole) => normalizedRole === principalRole);
}

/**
 * Titles a human would read as principal-level, spelled any which way.
 *
 * Deliberately fuzzier than {@link isPrincipalRole}: it strips every separator,
 * so "Headteacher", "head-teacher" and "Head Teacher" all land together. Used
 * only to prompt ("did you mean to grant full access?") — it must never grant.
 */
const PRINCIPALISH_COMPACT = new Set([
  'principal',
  'schoolprincipal',
  'headteacher',
  'headmaster',
  'headmistress',
  'schoolowner',
  'proprietor',
  'proprietress',
  'hm',
]);

export function looksLikePrincipalTitle(role: string | null | undefined): boolean {
  if (!role) return false;
  return PRINCIPALISH_COMPACT.has(role.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export class PermissionDto {
  @ApiProperty({ description: 'Permission ID' })
  id: string;

  @ApiProperty({ enum: PermissionResource, description: 'Resource area' })
  resource: PermissionResource;

  @ApiProperty({ enum: PermissionType, description: 'Permission type' })
  type: PermissionType;

  @ApiPropertyOptional({ description: 'Permission description' })
  description?: string;
}

export class AssignPermissionsDto {
  @ApiProperty({
    description: 'Array of permission IDs to assign',
    type: [String],
    example: ['perm1', 'perm2'],
  })
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}

export class StaffPermissionsDto {
  @ApiProperty({ description: 'Admin ID' })
  adminId: string;

  @ApiProperty({ description: 'Admin name' })
  adminName: string;

  @ApiProperty({ description: 'Admin role title (display only, not authority)' })
  role: string;

  @ApiProperty({
    enum: AdminAccessTier,
    description: 'Authority tier. PRINCIPAL bypasses the permission tables.',
  })
  accessTier: AdminAccessTier;

  @ApiProperty({ type: [PermissionDto], description: 'Assigned permissions' })
  permissions: PermissionDto[];
}
