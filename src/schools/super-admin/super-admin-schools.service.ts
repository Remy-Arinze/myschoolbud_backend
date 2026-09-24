import { Injectable, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { SchoolRepository } from '../domain/repositories/school.repository';
import { StaffRepository } from '../domain/repositories/staff.repository';
import { SchoolMapper } from '../domain/mappers/school.mapper';
import { IdGeneratorService } from '../shared/id-generator.service';
import { SchoolValidatorService } from '../shared/school-validator.service';
import { StaffValidatorService } from '../shared/staff-validator.service';
import { CreateSchoolDto } from '../dto/create-school.dto';
import { UpdateSchoolDto } from '../dto/update-school.dto';
import { SchoolDto } from '../dto/school.dto';
import { generateSecurePasswordHash } from '../../common/utils/password.utils';
import { AdminAccessTier, isPrincipalRole, canonicalizeUniqueTitle, isUniqueAdminTitle, uniqueTitleDisplayName } from '../dto/permission.dto';
import { EmailService } from '../../email/email.service';
import { PortalsService } from '../../portals/portals.service';
import { SchoolLifecycleService } from '../lifecycle/school-lifecycle.service';

/**
 * Service for super admin school management operations
 * Handles creating, updating, deleting, and listing schools
 */
@Injectable()
export class SuperAdminSchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly schoolRepository: SchoolRepository,
    private readonly staffRepository: StaffRepository,
    private readonly schoolMapper: SchoolMapper,
    private readonly idGenerator: IdGeneratorService,
    private readonly schoolValidator: SchoolValidatorService,
    private readonly staffValidator: StaffValidatorService,
    private readonly emailService: EmailService,
    private readonly portals: PortalsService,
    private readonly lifecycle: SchoolLifecycleService,
  ) { }

  /**
   * Create a school with optional principal and admins
   */
  async createSchool(createSchoolDto: CreateSchoolDto): Promise<SchoolDto> {
    const { owner, admins, levels, ...schoolData } = createSchoolDto;

    // Sanitize school data (subdomain is now purged)
    const sanitizedSchoolData = this.sanitizeSchoolData(schoolData);

    // Validate school data
    this.schoolValidator.validateSchoolData(sanitizedSchoolData);


    // Validate and sanitize school email if provided
    if (sanitizedSchoolData.email) {
      // Validate email format
      if (!this.isValidEmail(sanitizedSchoolData.email)) {
        throw new BadRequestException('Invalid school email format');
      }

      if (admins && admins.length > 0) {
        const conflictingAdmin = admins.find(
          admin => admin.email.toLowerCase().trim() === sanitizedSchoolData.email
        );
        if (conflictingAdmin) {
          throw new ConflictException(
            'School email cannot be the same as an admin email. Each admin will receive their own account.'
          );
        }
      }
    }

    // Sanitize owner data
    const sanitizedOwner = this.sanitizeOwnerData(owner);

    // Sanitize admins data if provided
    const sanitizedAdmins = admins && admins.length > 0
      ? admins.map(admin => this.sanitizeAdminData(admin))
      : null;

    // Generate unique school ID
    const schoolId = await this.idGenerator.generateSchoolId();

    // Generate owner ID and public ID
    const ownerId = await this.idGenerator.generatePrincipalId();
    const ownerPublicId = await this.idGenerator.generatePublicId(sanitizedSchoolData.name, 'admin');

    // Generate admin IDs and public IDs for additional admins before transaction
    const adminIds: string[] = [];
    const adminPublicIds: string[] = [];
    if (sanitizedAdmins && sanitizedAdmins.length > 0) {
      for (const admin of sanitizedAdmins) {
        // Use centralized isPrincipalRole function
        const isPrincipal = isPrincipalRole(admin.role);
        if (isPrincipal) {
          adminIds.push(await this.idGenerator.generatePrincipalId());
        } else {
          adminIds.push(await this.idGenerator.generateAdminId());
        }
        adminPublicIds.push(await this.idGenerator.generatePublicId(sanitizedSchoolData.name, 'admin'));
      }
    }

    // No longer generating owner ID from school email as it's separate

    // Generate default password for admins
    const defaultPassword = await generateSecurePasswordHash();

    try {
      // Create school with admins in a transaction
      const result = await this.prisma.$transaction(async (tx) => {
        // Create school - use transaction client directly
        const newSchool = await tx.school.create({
          data: {
            ...sanitizedSchoolData,
            schoolId,
            country: sanitizedSchoolData.country || 'Nigeria',
            hasPrimary: levels?.primary || false,
            hasSecondary: levels?.secondary || false,
            hasTertiary: levels?.tertiary || false,
          },
        });

        const createdAdmins: any[] = [];
        const emailQueue: Array<{
          userId: string;
          email: string;
          name: string;
          role: string;
          publicId: string;
        }> = [];

        // Create owner (Primary School Admin)
        const ownerData = await this.createAdminUser(
          tx,
          sanitizedOwner.email,
          sanitizedOwner.phone,
          defaultPassword
        );

        // Validate owner role (using school_owner role consistently)
        await this.staffValidator.validatePrincipalRole(newSchool.id, 'school_owner');

        // Create owner admin
        const schoolOwner = await tx.schoolAdmin.create({
          data: {
            adminId: ownerId,
            publicId: ownerPublicId,
            firstName: sanitizedOwner.firstName,
            lastName: sanitizedOwner.lastName,
            email: sanitizedOwner.email,
            phone: sanitizedOwner.phone,
            role: 'school_owner',
            // The owner must never be locked out of their own school.
            accessTier: AdminAccessTier.PRINCIPAL,
            userId: ownerData.user.id,
            schoolId: newSchool.id,
          },
          include: { user: true, school: true },
        });

        createdAdmins.push(schoolOwner);
        emailQueue.push({
          userId: ownerData.user.id,
          email: sanitizedOwner.email,
          name: `${sanitizedOwner.firstName} ${sanitizedOwner.lastName}`,
          role: 'School Owner',
          publicId: ownerPublicId,
        });

        const takenCanonicalTitles = new Set<string>(['school_owner']);

        // Create additional admins if provided
        if (sanitizedAdmins && sanitizedAdmins.length > 0) {
          for (let i = 0; i < sanitizedAdmins.length; i++) {
            const admin = sanitizedAdmins[i];
            const adminId = adminIds[i];

            // Provisioning is the one place a principal title still implies the
            // tier: a super-admin naming a school's Principal means it. The tier
            // is then written explicitly, so nothing downstream reads the title.
            const isPrincipal = isPrincipalRole(admin.role);
            if (isPrincipal) {
              this.staffValidator.assertCanAssignPrincipalTitle(
                'school_owner',
                admin.role,
                'SUPER_ADMIN',
              );
              if (isUniqueAdminTitle(admin.role)) {
                const canonical = canonicalizeUniqueTitle(admin.role);
                if (takenCanonicalTitles.has(canonical)) {
                  throw new ConflictException(
                    `This school already has a ${uniqueTitleDisplayName(admin.role)}.`,
                  );
                }
                takenCanonicalTitles.add(canonical);
              }
              await this.staffValidator.validateUniqueCanonicalTitle(newSchool.id, admin.role);
            }

            // Validate staff data
            this.staffValidator.validateStaffData(admin);

            const adminData = await this.createAdminUser(
              tx,
              admin.email,
              admin.phone,
              defaultPassword
            );

            // Normalize role to use underscores for multi-word roles
            const normalizedRole = this.normalizeRoleName(admin.role);

            // Create admin - use transaction client directly
            const newAdmin = await tx.schoolAdmin.create({
              data: {
                adminId: adminId,
                publicId: adminPublicIds[i],
                firstName: admin.firstName,
                lastName: admin.lastName,
                email: admin.email,
                phone: admin.phone,
                role: normalizedRole,
                accessTier: isPrincipal ? AdminAccessTier.PRINCIPAL : AdminAccessTier.STAFF,
                userId: adminData.user.id,
                schoolId: newSchool.id,
              },
              include: { user: true, school: true },
            });

            createdAdmins.push(newAdmin);
            emailQueue.push({
              userId: adminData.user.id,
              email: admin.email,
              name: `${admin.firstName} ${admin.lastName}`,
              role: isPrincipal ? 'Principal' : admin.role || 'Administrator',
              publicId: adminPublicIds[i],
            });
          }
        }

        return { school: newSchool, admins: createdAdmins, emailQueue };
      });

      await this.portals.ensureSlug(result.school.id);
      await this.portals.lockSlug(result.school.id);

      // Send password reset emails (outside transaction)
      for (const emailData of result.emailQueue) {
        try {
          await this.authService.sendPasswordResetForNewUser(
            emailData.userId,
            emailData.email,
            emailData.name,
            emailData.role,
            emailData.publicId,
            result.school.name
          );
        } catch (error) {
          console.error(`Failed to send password reset email to ${emailData.email}:`, error);
        }
      }

      // Fetch complete school data with relations
      const completeSchool = await this.prisma.school.findUnique({
        where: { id: result.school.id },
        include: {
          admins: {
            include: { user: true },
            orderBy: { role: 'asc' },
          },
          teachers: true,
          enrollments: {
            where: { isActive: true },
          },
        },
      });

      if (!completeSchool) {
        throw new BadRequestException('Failed to retrieve created school');
      }

      return this.schoolMapper.toDto(completeSchool);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to create school: ' + error.message);
    }
  }

  /**
   * Get all schools with pagination, search, and filtering
   */
  async findAll(
    pagination?: {
      page?: number;
      limit?: number;
      search?: string;
      filter?: 'all' | 'active' | 'inactive';
    },
  ): Promise<{
    data: SchoolDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    statusCounts: {
      total: number;
      active: number;
      inactive: number;
      unapproved: number;
    };
  }> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 10;
    const skip = (page - 1) * limit;
    const search = pagination?.search?.trim();
    const filter = pagination?.filter || 'all';

    // Search applies to both the list and the KPI cards. The status pill
    // filters the list only, so the cards stay stable while paging or filtering.
    const searchWhere: any = {};
    if (search) {
      searchWhere.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { state: { contains: search, mode: 'insensitive' } },
      ];
    }

    const where: any = { ...searchWhere };
    if (filter !== 'all') {
      where.isActive = filter === 'active';
    }

    const [total, scopeTotal, activeSchools, inactiveSchools, unapprovedSchools] =
      await Promise.all([
        this.prisma.school.count({ where }),
        this.prisma.school.count({ where: searchWhere }),
        this.prisma.school.count({ where: { ...searchWhere, isActive: true } }),
        this.prisma.school.count({
          where: { ...searchWhere, isActive: false, registrationStatus: 'VERIFIED' },
        }),
        this.prisma.school.count({
          where: {
            ...searchWhere,
            registrationStatus: { in: ['UNAPPROVED', 'PENDING'] },
          },
        }),
      ]);

    const statusCounts = {
      total: scopeTotal,
      active: activeSchools,
      inactive: inactiveSchools,
      unapproved: unapprovedSchools,
    };

    // Get paginated schools with bounded nested relations (list view)
    const schools = await this.prisma.school.findMany({
      where,
      include: {
        admins: {
          include: { user: true },
          orderBy: { role: 'asc' },
          take: 10,
        },
        teachers: {
          take: 10,
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });

    const schoolIds = schools.map((s) => s.id);
    if (schoolIds.length === 0) {
      return {
        data: [],
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
        statusCounts,
      };
    }

    // Batch counts for students (active enrollments) and teachers per school (indexed, scalable)
    const [enrollmentCounts, teacherCounts] = await Promise.all([
      this.prisma.enrollment.groupBy({
        by: ['schoolId'],
        where: { schoolId: { in: schoolIds }, isActive: true },
        _count: { id: true },
      }),
      this.prisma.teacher.groupBy({
        by: ['schoolId'],
        where: { schoolId: { in: schoolIds } },
        _count: { id: true },
      }),
    ]);

    const countsMap: Record<string, { studentsCount: number; teachersCount: number }> = {};
    schoolIds.forEach((id) => {
      countsMap[id] = { studentsCount: 0, teachersCount: 0 };
    });
    enrollmentCounts.forEach((row) => {
      countsMap[row.schoolId].studentsCount = row._count.id;
    });
    teacherCounts.forEach((row) => {
      countsMap[row.schoolId].teachersCount = row._count.id;
    });

    const totalPages = Math.ceil(total / limit);

    return {
      data: this.schoolMapper.toDtoArray(schools, countsMap),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      statusCounts,
    };
  }

  /**
   * Get school by ID
   */
  async findOne(id: string): Promise<SchoolDto> {
    const school = await this.schoolRepository.findById(id);

    if (!school) {
      throw new BadRequestException('School not found');
    }

    const completeSchool = await this.prisma.school.findUnique({
      where: { id: school.id },
      include: {
        admins: {
          include: { user: true },
          orderBy: { role: 'asc' },
        },
        teachers: true,
        enrollments: {
          where: { isActive: true },
        },
      },
    });

    if (!completeSchool) {
      throw new BadRequestException('School not found');
    }

    return this.schoolMapper.toDto(completeSchool);
  }

  /**
   * Update a school
   */
  async updateSchool(id: string, updateSchoolDto: UpdateSchoolDto): Promise<SchoolDto> {
    const { levels, ...schoolData } = updateSchoolDto;

    // Sanitize school data
    const sanitizedSchoolData = this.sanitizeSchoolData(schoolData);

    // Validate school data
    this.schoolValidator.validateSchoolData(sanitizedSchoolData);

    // Prepare email queue for new school owner if email changed
    const emailQueue: Array<{
      userId: string;
      email: string;
      name: string;
      role: string;
      publicId: string;
    }> = [];

    try {
      // Update school and handle school owner in a transaction
      // Fetch school once inside transaction to avoid race conditions and reduce queries
      const result = await this.prisma.$transaction(async (tx) => {
        // Fetch existing school with admins (single query, inside transaction for consistency)
        const existingSchool = await tx.school.findUnique({
          where: { id },
          include: {
            admins: {
              include: { user: true },
            },
          },
        });

        if (!existingSchool) {
          throw new BadRequestException('School not found');
        }

        // Subdomain is no longer changeable by user


        // Check if email is being changed (compare sanitized versions)
        const oldEmail = existingSchool.email
          ? existingSchool.email.toLowerCase().trim()
          : null;
        const newEmail = sanitizedSchoolData.email
          ? sanitizedSchoolData.email.toLowerCase().trim()
          : null;
        const emailChanged = newEmail !== oldEmail;

        // Find existing school owner
        const existingSchoolOwner = existingSchool.admins.find((admin) => {
          const roleLower = admin.role?.trim().toLowerCase() || '';
          return roleLower === 'school_owner';
        });

        // Update school
        const updatedSchool = await tx.school.update({
          where: { id },
          data: {
            ...sanitizedSchoolData,
            hasPrimary: levels?.primary !== undefined ? levels.primary : existingSchool.hasPrimary,
            hasSecondary:
              levels?.secondary !== undefined ? levels.secondary : existingSchool.hasSecondary,
            hasTertiary: levels?.tertiary !== undefined ? levels.tertiary : existingSchool.hasTertiary,
          },
        });

        // Return complete school data from transaction to avoid another query
        const completeSchool = await tx.school.findUnique({
          where: { id },
          include: {
            admins: {
              include: { user: true },
              orderBy: { role: 'asc' },
            },
            teachers: true,
            enrollments: {
              where: { isActive: true },
            },
          },
        });

        if (!completeSchool) {
          throw new BadRequestException('Failed to retrieve updated school');
        }

        return completeSchool;
      });

      // Send password reset email for new school owner (outside transaction)
      if (emailQueue.length > 0) {
        for (const emailData of emailQueue) {
          try {
            await this.authService.sendPasswordResetForNewUser(
              emailData.userId,
              emailData.email,
              emailData.name,
              emailData.role,
              emailData.publicId,
              result.name
            );
          } catch (error) {
            console.error(`Failed to send password reset email to ${emailData.email}:`, error);
            // Don't throw - email failure shouldn't prevent school update
          }
        }
      }

      return this.schoolMapper.toDto(result);
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to update school: ' + error.message);
    }
  }

  /**
   * Activate a school
   */
  async activateSchool(schoolId: string): Promise<SchoolDto> {
    return this.lifecycle.reactivate(schoolId);
  }

  /**
   * Schedule a school close (7-day delay). Never hard-deletes.
   */
  async deactivateSchool(schoolId: string, reason: string, actorUserId: string): Promise<SchoolDto> {
    return this.lifecycle.scheduleClose(schoolId, reason, {
      userId: actorUserId,
      role: 'SUPER_ADMIN',
    });
  }

  async cancelClose(schoolId: string): Promise<SchoolDto> {
    return this.lifecycle.cancelClose(schoolId);
  }

  /**
   * Get all pending school registrations
   */
  async findPendingSchools(): Promise<SchoolDto[]> {
    const schools = await this.prisma.school.findMany({
      where: { registrationStatus: 'UNAPPROVED' },
      include: {
        admins: {
          where: { role: 'school_owner' },
          include: { user: true }
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return schools.map(s => this.schoolMapper.toDto(s));
  }

  /**
   * Verify a pending school registration
   */
  async verifySchool(schoolId: string, adminId: string): Promise<SchoolDto> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        admins: {
          where: { role: 'school_owner' },
          include: { user: true },
        },
      },
    });

    if (!school) {
      // Will throw standard exception for not found
      throw new BadRequestException('School not found');
    }
    if (school.registrationStatus === 'VERIFIED') throw new BadRequestException('School is already verified');

    const slug = await this.portals.ensureSlug(schoolId);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Mark school as verified and active
      const updatedSchool = await tx.school.update({
        where: { id: schoolId },
        data: {
          registrationStatus: 'VERIFIED',
          isActive: true,
          lifecycleStatus: 'ACTIVE',
          verifiedAt: new Date(),
          verifiedBy: adminId,
        },
      });

      // 2. Mark principal's user account as ACTIVE
      const principalAdmin = school.admins[0];
      if (principalAdmin && principalAdmin.userId) {
        await tx.user.update({
          where: { id: principalAdmin.userId },
          data: { accountStatus: 'ACTIVE' },
        });

        // 3. Send password setup email to principal
        await this.authService.sendPasswordResetForNewUser(
          principalAdmin.userId,
          principalAdmin.user.email!,
          `${principalAdmin.firstName} ${principalAdmin.lastName}`,
          'School Owner',
          principalAdmin.publicId!,
          updatedSchool.name,
          undefined,
          updatedSchool.id,
        );
      }

      return updatedSchool;
    });

    await this.portals.lockSlug(result.id);

    return this.findOne(result.id);
  }

  async renameSlug(schoolId: string, slug: string): Promise<SchoolDto> {
    await this.schoolValidator.validateSchoolExists(schoolId);
    await this.portals.renameSlug(schoolId, slug);
    return this.findOne(schoolId);
  }


  /**
   * Reject a pending school registration
   */
  async rejectSchool(schoolId: string, reason: string): Promise<SchoolDto> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        admins: {
          where: { role: 'school_owner' },
          include: { user: true }
        },
      }
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    if (school.registrationStatus === 'VERIFIED') {
      throw new BadRequestException('Cannot reject a verified school');
    }

    const updatedSchool = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        registrationStatus: 'REJECTED',
        rejectionReason: reason,
      },
    });
    await this.portals.holdSlugOnReject(schoolId);

    // Notify the school
    const principalAdmin = school.admins[0];
    if (principalAdmin && principalAdmin.user?.email) {
      await this.emailService.sendSchoolRejectedEmail(
        principalAdmin.user.email,
        updatedSchool.name,
        `${principalAdmin.firstName} ${principalAdmin.lastName}`,
        reason
      );
    }

    return this.findOne(updatedSchool.id);
  }

  /**
   * Helper: Create or update admin user
   * Creates a new SHADOW user or updates existing user's password and phone
   */
  private async createAdminUser(
    tx: any,
    email: string,
    phone: string,
    password: string
  ): Promise<{ user: any }> {
    let user = await tx.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Create new user with SHADOW status (needs to activate via email)
      user = await tx.user.create({
        data: {
          email,
          phone: phone || null,
          passwordHash: password,
          accountStatus: 'SHADOW',
          role: 'SCHOOL_ADMIN',
        },
      });
    } else {
      // Update existing user: reset password and update phone if provided
      // Don't change accountStatus - let them activate if needed
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: password,
          phone: phone || user.phone, // Update phone if provided, otherwise keep existing
          role: 'SCHOOL_ADMIN', // Ensure correct role
        },
      });
    }

    return { user };
  }

  /**
   * Helper: Normalize role name to use underscores for multi-word roles
   * This ensures consistency with PRINCIPAL_ROLES array
   */
  private normalizeRoleName(role: string): string {
    if (!role) return 'Administrator';

    // Trim and normalize
    const normalized = role.trim();

    // If it's already a principal role (case-insensitive), return the canonical form
    if (isPrincipalRole(normalized)) {
      return canonicalizeUniqueTitle(normalized);
    }

    // For non-principal roles, replace spaces with underscores and lowercase
    return normalized.toLowerCase().replace(/\s+/g, '_');
  }

  /**
   * Helper: Validate email format
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Sanitize school data to prevent injection attacks and ensure data consistency
   */
  private sanitizeSchoolData(data: any): any {
    return {
      name: data.name ? this.sanitizeString(data.name, 2, 200) : undefined,
      domain: data.domain ? this.sanitizeString(data.domain, 0, 255) : undefined,
      address: data.address ? this.sanitizeString(data.address, 0, 500) : undefined,
      city: data.city ? this.sanitizeString(data.city, 0, 100) : undefined,
      state: data.state ? this.sanitizeString(data.state, 0, 100) : undefined,
      country: data.country ? this.sanitizeString(data.country, 0, 100) : undefined,
      phone: data.phone ? this.sanitizePhone(data.phone) : undefined,
      email: data.email ? this.sanitizeEmail(data.email) : undefined,
    };
  }

  /**
   * Sanitize principal data
   */
  private sanitizeOwnerData(data: any): any {
    return {
      firstName: this.sanitizeString(data.firstName, 2, 50),
      lastName: this.sanitizeString(data.lastName, 2, 50),
      email: this.sanitizeEmail(data.email),
      phone: this.sanitizePhone(data.phone),
    };
  }

  /**
   * Sanitize admin data
   */
  private sanitizeAdminData(data: any): any {
    return {
      firstName: this.sanitizeString(data.firstName, 2, 50),
      lastName: this.sanitizeString(data.lastName, 2, 50),
      email: this.sanitizeEmail(data.email),
      phone: this.sanitizePhone(data.phone),
      role: this.sanitizeString(data.role, 2, 50) || 'Administrator',
    };
  }

  /**
   * Sanitize string input - removes dangerous characters and trims
   */
  private sanitizeString(input: string, minLength: number = 0, maxLength: number = 1000): string {
    if (!input || typeof input !== 'string') {
      throw new BadRequestException('Invalid string input');
    }

    // Remove null bytes and control characters (except newlines and tabs)
    let sanitized = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    // Trim whitespace
    sanitized = sanitized.trim();

    // Remove HTML tags to prevent XSS
    sanitized = sanitized.replace(/<[^>]*>/g, '');

    // Validate length
    if (minLength > 0 && sanitized.length < minLength) {
      throw new BadRequestException(`Input must be at least ${minLength} characters`);
    }
    if (sanitized.length > maxLength) {
      throw new BadRequestException(`Input must be at most ${maxLength} characters`);
    }

    return sanitized;
  }

  /**
   * Sanitize email input
   */
  private sanitizeEmail(email: string): string {
    if (!email || typeof email !== 'string') {
      throw new BadRequestException('Invalid email input');
    }

    // Trim and lowercase
    const sanitized = email.trim().toLowerCase();

    // Validate email format
    if (!this.isValidEmail(sanitized)) {
      throw new BadRequestException('Invalid email format');
    }

    // Additional security: check for dangerous patterns
    if (sanitized.includes('..') || sanitized.includes('@.') || sanitized.includes('.@')) {
      throw new BadRequestException('Invalid email format');
    }

    return sanitized;
  }

  /**
   * Sanitize phone input
   */
  private sanitizePhone(phone: string): string {
    if (!phone || typeof phone !== 'string') {
      throw new BadRequestException('Invalid phone input');
    }

    // Remove all whitespace and special characters except + and digits
    const sanitized = phone.replace(/[^\d+]/g, '');

    // Validate phone format
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(sanitized)) {
      throw new BadRequestException('Invalid phone format');
    }

    return sanitized;
  }


}
