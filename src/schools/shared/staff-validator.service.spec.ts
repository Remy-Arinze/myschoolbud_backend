import { ConflictException, ForbiddenException } from '@nestjs/common';
import { StaffValidatorService } from './staff-validator.service';

describe('StaffValidatorService unique titles', () => {
  const prisma = {
    schoolAdmin: { findMany: jest.fn() },
  };
  const validator = new StaffValidatorService(prisma as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a second principal even when the stored role is school_principal', async () => {
    prisma.schoolAdmin.findMany.mockResolvedValue([
      { id: 'a1', role: 'school_principal' },
    ]);

    await expect(
      validator.validateUniqueCanonicalTitle('school-1', 'Principal'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a headmistress when a principal already exists', async () => {
    prisma.schoolAdmin.findMany.mockResolvedValue([{ id: 'a1', role: 'principal' }]);

    await expect(
      validator.validateUniqueCanonicalTitle('school-1', 'Headmistress'),
    ).resolves.toBeUndefined();
  });

  it('rejects a second Head Teacher when stored as head_teacher', async () => {
    prisma.schoolAdmin.findMany.mockResolvedValue([{ id: 'a1', role: 'head_teacher' }]);

    await expect(
      validator.validateUniqueCanonicalTitle('school-1', 'Head Teacher'),
    ).rejects.toThrow('This school already has a Head Teacher.');
  });

  it('allows unlimited vice principals', async () => {
    prisma.schoolAdmin.findMany.mockResolvedValue([{ id: 'a1', role: 'vice_principal' }]);

    await expect(
      validator.validateUniqueCanonicalTitle('school-1', 'Vice Principal'),
    ).resolves.toBeUndefined();
    expect(prisma.schoolAdmin.findMany).not.toHaveBeenCalled();
  });

  it('blocks minting a second school owner', () => {
    expect(() =>
      validator.assertCanAssignPrincipalTitle('school_owner', 'school_owner'),
    ).toThrow(ForbiddenException);
  });

  it('blocks a principal from minting a headmistress', () => {
    expect(() =>
      validator.assertCanAssignPrincipalTitle('principal', 'headmistress'),
    ).toThrow(ForbiddenException);
  });

  it('lets the school owner mint a principal', () => {
    expect(() =>
      validator.assertCanAssignPrincipalTitle('school_owner', 'principal'),
    ).not.toThrow();
  });
});
