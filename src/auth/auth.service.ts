import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { OtpService } from './otp.service';
import { PasswordOtpService } from './password-otp.service';
import { CloudinaryService } from '../storage/cloudinary/cloudinary.service';
import { LoginDto, VerifyOtpDto, VerifyLoginOtpDto, AuthTokensDto, LoginResponseDto } from './dto/login.dto';
import { RequestPasswordResetDto, ResetPasswordDto } from './dto/password-reset.dto';
import { RequestChangePasswordDto } from './dto/request-change-password.dto';
import { ConfirmChangePasswordDto } from './dto/confirm-change-password.dto';
import { VerifyResetPasswordDto } from './dto/verify-reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtPayload } from './types/user-with-context.type';
import { MetricsService } from '../common/metrics/metrics.service';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { generateSecurePasswordHash } from '../common/utils/password.utils';
import { SchoolSettingsService } from '../school-settings/school-settings.service';
import { PortalsService } from '../portals/portals.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly otpService: OtpService,
    private readonly passwordOtpService: PasswordOtpService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly metricsService: MetricsService,
    private readonly schoolSettingsService: SchoolSettingsService,
    private readonly portals: PortalsService,
  ) { }

  private applyPortalSchoolHint(
    user: any,
    current: {
      currentSchoolId: string | null;
      currentPublicId: string | null;
      currentProfileId: string | null;
    },
    portalSchoolId?: string | null,
  ) {
    if (!portalSchoolId) return current;
    if (user.role === 'SUPER_ADMIN') {
      throw new BadRequestException('Use the main Myschoolbud login for this account.');
    }
    if (user.role === 'SCHOOL_ADMIN') {
      const admin = (user.schoolAdmins || []).find((a: any) => a.schoolId === portalSchoolId);
      if (!admin) {
        throw new UnauthorizedException('This account belongs to another school.');
      }
      return {
        currentSchoolId: admin.schoolId,
        currentPublicId: admin.publicId,
        currentProfileId: admin.id,
      };
    }
    if (user.role === 'TEACHER') {
      const teacher = (user.teacherProfiles || []).find((t: any) => t.schoolId === portalSchoolId);
      if (!teacher) {
        throw new UnauthorizedException('This account belongs to another school.');
      }
      return {
        currentSchoolId: teacher.schoolId,
        currentPublicId: teacher.publicId,
        currentProfileId: teacher.id,
      };
    }
    if (user.role === 'STUDENT') {
      const enrollment = user.studentProfile?.enrollments?.find((e: any) => e.schoolId === portalSchoolId);
      if (!enrollment) {
        throw new UnauthorizedException('This account belongs to another school.');
      }
      return {
        currentSchoolId: enrollment.schoolId,
        currentPublicId: user.studentProfile?.publicId || null,
        currentProfileId: current.currentProfileId,
      };
    }
    return current;
  }

  private async attachPortalPayload(
    result: AuthTokensDto,
    schoolId: string | null,
    userAgent?: string,
  ): Promise<AuthTokensDto> {
    if (!schoolId || result.user.role === 'SUPER_ADMIN') {
      return result;
    }
    const slug = await this.portals.ensureSlug(schoolId);
    const portalUrl = await this.portals.getSchoolFrontendUrl(schoolId);
    const transferCode = await this.portals.createTransferCode(
      result.user.id,
      schoolId,
      userAgent,
    );
    result.user.slug = slug;
    result.user.portalUrl = portalUrl;
    result.slug = slug;
    result.portalUrl = portalUrl;
    result.transferCode = transferCode;
    await this.attachLifecycle(result, schoolId);
    return result;
  }

  private async attachLifecycle(result: AuthTokensDto, schoolId: string | null): Promise<void> {
    if (!schoolId) return;
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        lifecycleStatus: true,
        isActive: true,
        deactivatesAt: true,
        deactivationReason: true,
        deactivatedAt: true,
      },
    });
    if (!school) return;
    result.user.lifecycleStatus =
      school.lifecycleStatus || (school.isActive ? 'ACTIVE' : 'DEACTIVATED');
    result.user.deactivatesAt = school.deactivatesAt?.toISOString() || null;
    result.user.deactivationReason = school.deactivationReason || null;
    result.user.deactivatedAt = school.deactivatedAt?.toISOString() || null;
  }

  async switchSchoolContext(userId: string, targetSchoolId: string, userAgent?: string): Promise<AuthTokensDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        schoolAdmins: true,
        teacherProfiles: true,
        studentProfile: { include: { enrollments: true } },
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    if (user.role === 'STUDENT') {
      const enrollment = user.studentProfile?.enrollments?.find(
        (e) => e.schoolId === targetSchoolId && e.isActive,
      );
      if (!enrollment) throw new ForbiddenException('You are not enrolled at that school.');
      const target = await this.prisma.school.findUnique({
        where: { id: targetSchoolId },
        select: { isActive: true, lifecycleStatus: true },
      });
      if (!target || !target.isActive || target.lifecycleStatus === 'DEACTIVATED') {
        throw new ForbiddenException('That school is not available.');
      }
    } else if (user.role === 'TEACHER') {
      if (!(user.teacherProfiles || []).some((t) => t.schoolId === targetSchoolId)) {
        throw new ForbiddenException('You do not belong to that school.');
      }
    } else if (user.role === 'SCHOOL_ADMIN') {
      if (!(user.schoolAdmins || []).some((a) => a.schoolId === targetSchoolId)) {
        throw new ForbiddenException('You do not belong to that school.');
      }
    } else {
      throw new ForbiddenException('Cannot switch school for this account.');
    }

    const hinted = this.applyPortalSchoolHint(
      user,
      { currentSchoolId: targetSchoolId, currentPublicId: null, currentProfileId: null },
      targetSchoolId,
    );
    let adminRole: string | null = null;
    let adminAccessTier: string | null = null;
    if (user.role === 'SCHOOL_ADMIN' && hinted.currentProfileId) {
      const admin = (user.schoolAdmins || []).find((a) => a.id === hinted.currentProfileId);
      adminRole = admin?.role || null;
      adminAccessTier = admin?.accessTier || null;
    }
    const tokens = await this.generateTokens(
      user.id,
      user.role,
      hinted.currentSchoolId,
      hinted.currentPublicId,
      hinted.currentProfileId,
      adminRole,
    );
    const payload: AuthTokensDto = {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        accountStatus: user.accountStatus,
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        profileId: hinted.currentProfileId,
        publicId: hinted.currentPublicId,
        schoolId: hinted.currentSchoolId,
        tenantId: hinted.currentSchoolId,
        adminRole,
        adminAccessTier,
        slug: null,
        portalUrl: null,
      },
    };
    return this.attachPortalPayload(payload, hinted.currentSchoolId, userAgent);
  }

  /**
   * Validate user credentials and return user with school context
   * This is used internally by login and verifyLoginOtp
   */
  private async validateCredentials(
    emailOrPublicId: string,
    password: string,
    portalSchoolId?: string | null,
  ): Promise<{
    user: any;
    currentSchoolId: string | null;
    currentPublicId: string | null;
    currentProfileId: string | null;
  }> {
    // Determine if it's an email or public ID
    const isEmail = emailOrPublicId.includes('@');

    let user;
    let schoolAdmin: any = null;
    let teacherProfile: any = null;

    if (isEmail) {
      // Super admin or user logging in with email
      user = await this.prisma.user.findFirst({
        where: {
          email: emailOrPublicId,
        },
        include: {
          studentProfile: {
            include: {
              enrollments: {
                where: { isActive: true },
                orderBy: { enrollmentDate: 'desc' },
                include: { school: true },
              },
            },
          },
          parentProfile: true,
          teacherProfiles: true,
          schoolAdmins: true,
        },
      });
    } else {
      // Admin, principal, teacher, or student logging in with public ID
      const [adminResult, teacherResult, studentResult] = await Promise.all([
        this.prisma.schoolAdmin.findUnique({
          where: { publicId: emailOrPublicId },
          include: { user: true },
        }),
        this.prisma.teacher.findUnique({
          where: { publicId: emailOrPublicId },
          include: { user: true },
        }),
        this.prisma.student.findUnique({
          where: { publicId: emailOrPublicId },
          include: { user: true },
        }),
      ]);

      schoolAdmin = adminResult;
      teacherProfile = teacherResult;

      if (studentResult) {
        user = studentResult.user;
      }

      if (!schoolAdmin && !teacherProfile && !user) {
        throw new UnauthorizedException('Invalid credentials');
      }

      if (!user) {
        user = schoolAdmin?.user || teacherProfile?.user;
      }

      if (user) {
        // Reload user with all relations
        user = await this.prisma.user.findUnique({
          where: { id: user.id },
          include: {
            studentProfile: {
              include: {
                enrollments: {
                  where: { isActive: true },
                  orderBy: { enrollmentDate: 'desc' },
                  take: 1,
                  include: { school: true },
                },
              },
            },
            parentProfile: true,
            teacherProfiles: true,
            schoolAdmins: true,
          },
        });
      }
    }

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Determine school context based on login method and role
    let currentSchoolId: string | null = null;
    let currentPublicId: string | null = null;
    let currentProfileId: string | null = null;

    if (isEmail) {
      // Email login - determine school context based on role
      if (user.role === 'STUDENT') {
        if (user.studentProfile && user.studentProfile.enrollments.length > 0) {
          const activeEnrollment = user.studentProfile.enrollments[0];
          currentSchoolId = activeEnrollment.schoolId;
          currentPublicId = user.studentProfile.publicId || null;
        }
      } else if (
        user.role === 'SCHOOL_ADMIN' &&
        user.schoolAdmins &&
        user.schoolAdmins.length > 0
      ) {
        const adminProfile = user.schoolAdmins[0];
        currentSchoolId = adminProfile.schoolId;
        currentPublicId = adminProfile.publicId;
        currentProfileId = adminProfile.id;
      } else if (
        user.role === 'TEACHER' &&
        user.teacherProfiles &&
        user.teacherProfiles.length > 0
      ) {
        const teacherProf = user.teacherProfiles[0];
        currentSchoolId = teacherProf.schoolId;
        currentPublicId = teacherProf.publicId;
        currentProfileId = teacherProf.id;
      }
    } else {
      // Public ID login - capture school context
      if (schoolAdmin) {
        currentSchoolId = schoolAdmin.schoolId;
        currentPublicId = schoolAdmin.publicId;
        currentProfileId = schoolAdmin.id;
      } else if (teacherProfile) {
        currentSchoolId = teacherProfile.schoolId;
        currentPublicId = teacherProfile.publicId;
        currentProfileId = teacherProfile.id;
      } else if (user.role === 'STUDENT') {
        if (user.studentProfile && user.studentProfile.enrollments.length > 0) {
          const activeEnrollment = user.studentProfile.enrollments[0];
          currentSchoolId = activeEnrollment.schoolId;
          currentPublicId = user.studentProfile.publicId || null;
        }
      }
    }

    const hinted = this.applyPortalSchoolHint(
      user,
      { currentSchoolId, currentPublicId, currentProfileId },
      portalSchoolId,
    );
    currentSchoolId = hinted.currentSchoolId;
    currentPublicId = hinted.currentPublicId;
    currentProfileId = hinted.currentProfileId;

    // Check school verification status
    if (currentSchoolId) {
      const school = await this.prisma.school.findUnique({
        where: { id: currentSchoolId },
        select: { registrationStatus: true },
      });
      if (school) {
        if (school.registrationStatus === 'UNAPPROVED') {
          throw new UnauthorizedException('Your school registration is unapproved and under review. Please wait for verification.');
        } else if (school.registrationStatus === 'REJECTED') {
          throw new UnauthorizedException('Your school registration was rejected. Please contact support for more information.');
        }
      }
    }

    // Check if user is shadow (cannot login)
    if (user.accountStatus === 'SHADOW') {
      throw new UnauthorizedException(
        'Account not activated. Please verify your OTP to claim your account.',
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      this.metricsService.authFailedAttemptsTotal.inc({ ip: 'unknown' }); // Interceptor could pass IP if needed, but for now we track frequency
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      user,
      currentSchoolId,
      currentPublicId,
      currentProfileId,
    };
  }

  /**
   * Login - validates credentials and sends OTP
   * This method ALWAYS requires OTP verification - no exceptions
   */
  async login(
    loginDto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
    portalSchoolId?: string | null,
  ): Promise<LoginResponseDto> {
    this.logger.log(`[AUTH] Login attempt for: ${loginDto.emailOrPublicId}`);
    this.metricsService.authLoginAttemptsTotal.inc({ status: 'attempt' });

    try {
      const { emailOrPublicId, password } = loginDto;

      // Validate credentials
      const { user } = await this.validateCredentials(emailOrPublicId, password, portalSchoolId);
      this.logger.log(`[AUTH] Credentials validated for user: ${user.id}, role: ${user.role}. IP: ${ipAddress}, UA: ${userAgent}`);

      // Ensure user has an email (required for OTP)
      if (!user.email) {
        this.logger.error(`[AUTH] User ${user.id} has no email address`);
        throw new BadRequestException(
          'Email address is required for login. Please contact support.',
        );
      }

      // Create OTP session and send email - THIS IS MANDATORY
      this.logger.log(`[AUTH] Creating OTP session for user: ${user.id}, email: ${user.email}`);
      try {
        const sessionId = await this.otpService.createLoginSession(
          user.id,
          user.email,
          ipAddress,
          userAgent,
        );

        this.logger.log(`[AUTH] OTP session created successfully. SessionId: ${sessionId.substring(0, 8)}...`);

        // ALWAYS return OTP response - never return tokens directly
        return {
          requiresOtp: true,
          sessionId,
          email: user.email,
        };
      } catch (otpError) {
        this.logger.error(
          '[AUTH] Failed to create OTP session:',
          otpError instanceof Error ? otpError.stack : otpError,
        );
        // Re-throw with a clear message - DO NOT fall back to legacy login
        if (otpError instanceof BadRequestException) {
          throw otpError;
        }
        throw new BadRequestException(
          `Failed to send OTP: ${otpError instanceof Error ? otpError.message : 'Unknown error'}. Please ensure the database is properly migrated and email service is configured.`,
        );
      }
    } catch (error) {
      // Log the full error for debugging
      this.logger.error(
        'AuthService.login error:',
        error instanceof Error ? error.stack : error,
      );
      // If it's already a NestJS exception, re-throw it
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      // Handle Prisma errors with better messages
      if (error instanceof Error) {
        if (error.message.includes('Unknown field')) {
          throw new BadRequestException(
            'A system error occurred. Please contact support if this persists.',
          );
        }
        throw new BadRequestException(
          'Unable to complete login. Please check your credentials and try again.',
        );
      }
      throw new BadRequestException('Login failed. Please try again later.');
    }
  }

  /**
   * Verify login OTP and complete authentication
   */
  async verifyLoginOtp(
    verifyOtpDto: VerifyLoginOtpDto,
    portalSchoolId?: string | null,
    userAgent?: string,
  ): Promise<AuthTokensDto> {
    try {
      const { sessionId, code } = verifyOtpDto;

      // Verify OTP
      const userId = await this.otpService.verifyOtp(sessionId, code);
      this.metricsService.authLoginAttemptsTotal.inc({ status: 'success' });

      // Get user with all relations
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          studentProfile: {
            include: {
              enrollments: {
                where: { isActive: true },
                orderBy: { enrollmentDate: 'desc' },
                include: { school: true },
              },
            },
          },
          parentProfile: true,
          teacherProfiles: true,
          schoolAdmins: true,
        },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Update last login
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      // Determine school context based on role
      let currentSchoolId: string | null = null;
      let currentPublicId: string | null = null;
      let currentProfileId: string | null = null;
      let adminRole: string | null = null;
      let adminAccessTier: string | null = null;
      let adminSchoolType: string | null = null;

      if (user.role === 'STUDENT') {
        if (user.studentProfile && user.studentProfile.enrollments.length > 0) {
          const activeEnrollment = user.studentProfile.enrollments[0];
          currentSchoolId = activeEnrollment.schoolId;
          currentPublicId = user.studentProfile.publicId || null;
        }
      } else if (
        user.role === 'SCHOOL_ADMIN' &&
        user.schoolAdmins &&
        user.schoolAdmins.length > 0
      ) {
        const adminProfile = user.schoolAdmins[0];
        currentSchoolId = adminProfile.schoolId;
        currentPublicId = adminProfile.publicId;
        currentProfileId = adminProfile.id;
        adminRole = adminProfile.role || null;
        adminAccessTier = adminProfile.accessTier || null;
        adminSchoolType = adminProfile.schoolType || null;
      } else if (
        user.role === 'TEACHER' &&
        user.teacherProfiles &&
        user.teacherProfiles.length > 0
      ) {
        const teacherProf = user.teacherProfiles[0];
        currentSchoolId = teacherProf.schoolId;
        currentPublicId = teacherProf.publicId;
        currentProfileId = teacherProf.id;
      }

      const hinted = this.applyPortalSchoolHint(
        user,
        { currentSchoolId, currentPublicId, currentProfileId },
        portalSchoolId,
      );
      currentSchoolId = hinted.currentSchoolId;
      currentPublicId = hinted.currentPublicId;
      currentProfileId = hinted.currentProfileId;
      if (user.role === 'SCHOOL_ADMIN' && currentProfileId) {
        const adminProfile = (user.schoolAdmins || []).find((a: any) => a.id === currentProfileId);
        adminRole = adminProfile?.role || null;
        adminAccessTier = adminProfile?.accessTier || null;
        adminSchoolType = adminProfile?.schoolType || null;
      }

      // Generate tokens with school context
      const tokens = await this.generateTokens(
        user.id,
        user.role,
        currentSchoolId,
        currentPublicId,
        currentProfileId,
        adminRole
      );

      const payload: AuthTokensDto = {
        ...tokens,
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          role: user.role,
          accountStatus: user.accountStatus,
          firstName: user.firstName || null,
          lastName: user.lastName || null,
          profileId: currentProfileId,
          publicId: currentPublicId,
          schoolId: currentSchoolId,
          tenantId: currentSchoolId, // JWT-first: tenantId IS the schoolId UUID
          adminRole,
          adminAccessTier,
          adminSchoolType,
        },
      };
      return this.attachPortalPayload(payload, currentSchoolId, userAgent);
    } catch (error) {
      this.logger.error(
        'AuthService.verifyLoginOtp error:',
        error instanceof Error ? error.stack : error,
      );
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        this.metricsService.authLoginAttemptsTotal.inc({ status: 'failed' });
        throw error;
      }
      this.metricsService.authLoginAttemptsTotal.inc({ status: 'error' });
      throw new BadRequestException('OTP verification failed');
    }
  }


  async verifyOtp(verifyOtpDto: VerifyOtpDto): Promise<AuthTokensDto> {
    const { phone, code } = verifyOtpDto;

    const parent = await this.prisma.parent.findFirst({
      where: { phone },
      include: {
        user: true,
        otpCodes: {
          where: {
            code,
            expiresAt: { gt: new Date() },
            usedAt: null,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!parent || parent.otpCodes.length === 0) {
      throw new BadRequestException('Invalid or expired OTP code');
    }

    const otpCode = parent.otpCodes[0];

    // Mark OTP as used
    await this.prisma.otpCode.update({
      where: { id: otpCode.id },
      data: { usedAt: new Date() },
    });

    // Get or create parent user account
    let updatedUser;
    if (!parent.userId) {
      // Create User account for parent (they're claiming their account via OTP)
      const defaultPassword = await generateSecurePasswordHash();
      const newUser = await this.prisma.user.create({
        data: {
          email: parent.email || null,
          phone: parent.phone,
          passwordHash: defaultPassword,
          accountStatus: 'ACTIVE',
          role: 'STUDENT', // Changed from PARENT - PARENT role removed
        },
      });

      // Link User to Parent
      await this.prisma.parent.update({
        where: { id: parent.id },
        data: { userId: newUser.id },
      });

      updatedUser = await this.prisma.user.findUnique({
        where: { id: newUser.id },
        include: {
          parentProfile: true,
          schoolAdmins: true,
          teacherProfiles: true,
        },
      });
    } else {
      // Activate existing parent account
      updatedUser = await this.prisma.user.update({
        where: { id: parent.userId },
        data: {
          accountStatus: 'ACTIVE',
        },
        include: {
          parentProfile: true,
          schoolAdmins: true,
          teacherProfiles: true,
        },
      });
    }

    // Lock student profiles linked to this parent
    const students = await this.prisma.studentGuardian.findMany({
      where: { parentId: parent.id },
      select: { studentId: true },
    });

    if (students.length > 0) {
      await this.prisma.student.updateMany({
        where: {
          id: { in: students.map((s: { studentId: string }) => s.studentId) },
        },
        data: {
          profileLocked: true,
        },
      });
    }

    if (!updatedUser) {
      throw new BadRequestException('Failed to update user');
    }

    const tokens = await this.generateTokens(updatedUser.id, updatedUser.role);

    // Get profile-specific ID (for parents, this would be null)
    let profileId: string | null = null;
    if (updatedUser.schoolAdmins && updatedUser.schoolAdmins.length > 0) {
      profileId = updatedUser.schoolAdmins[0].adminId;
    } else if (updatedUser.teacherProfiles && updatedUser.teacherProfiles.length > 0) {
      profileId = updatedUser.teacherProfiles[0].teacherId;
    }

    return {
      ...tokens,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        phone: updatedUser.phone,
        role: updatedUser.role,
        accountStatus: updatedUser.accountStatus,
        profileId: profileId,
      },
    };
  }

  async exchangePortalCode(code: string, userAgent?: string): Promise<AuthTokensDto> {
    const { userId, schoolId } = await this.portals.consumeTransferCode(code, userAgent);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        studentProfile: {
          include: {
            enrollments: { where: { isActive: true }, orderBy: { enrollmentDate: 'desc' } },
          },
        },
        teacherProfiles: true,
        schoolAdmins: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const hinted = this.applyPortalSchoolHint(
      user,
      { currentSchoolId: schoolId, currentPublicId: null, currentProfileId: null },
      schoolId,
    );
    let adminRole: string | null = null;
    let adminAccessTier: string | null = null;
    let adminSchoolType: string | null = null;
    if (user.role === 'SCHOOL_ADMIN' && hinted.currentProfileId) {
      const admin = (user.schoolAdmins || []).find((a: any) => a.id === hinted.currentProfileId);
      adminRole = admin?.role || null;
      adminAccessTier = admin?.accessTier || null;
      adminSchoolType = admin?.schoolType || null;
    }
    const tokens = await this.generateTokens(
      user.id,
      user.role,
      hinted.currentSchoolId,
      hinted.currentPublicId,
      hinted.currentProfileId,
      adminRole,
    );
    const payload: AuthTokensDto = {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        accountStatus: user.accountStatus,
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        profileId: hinted.currentProfileId,
        publicId: hinted.currentPublicId,
        schoolId: hinted.currentSchoolId,
        tenantId: hinted.currentSchoolId,
        adminRole,
        adminAccessTier,
        adminSchoolType,
        slug: (await this.portals.ensureSlug(schoolId)),
        portalUrl: await this.portals.getSchoolFrontendUrl(schoolId),
      },
      slug: await this.portals.ensureSlug(schoolId),
      portalUrl: await this.portals.getSchoolFrontendUrl(schoolId),
    };
    await this.attachLifecycle(payload, schoolId);
    return payload;
  }

  private async generateTokens(
    userId: string,
    role: string,
    schoolId?: string | null,
    publicId?: string | null,
    profileId?: string | null,
    contextRole?: string | null
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordChangedAt: true },
    });
    const pwdChangedAt = user?.passwordChangedAt
      ? Math.floor(user.passwordChangedAt.getTime() / 1000)
      : undefined;

    const payload: JwtPayload = {
      sub: userId,
      role,
      ...(schoolId && { schoolId }),
      ...(publicId && { publicId }),
      ...(profileId && { profileId }),
      ...(contextRole && { contextRole }),
      ...(pwdChangedAt !== undefined && { pwdChangedAt }),
    };

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: this.jwtService.sign(payload, { expiresIn: '7d' }),
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      // Verify refresh token
      const payload = this.jwtService.verify(refreshToken);

      // Validate user still exists and is active
      const user = await this.validateUser(payload.sub);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Invalidate token if password was changed after this token was issued
      // Only enforced if both the claim and the date exist to support pre-migration tokens
      if (
        user.passwordChangedAt &&
        payload.pwdChangedAt !== undefined &&
        payload.pwdChangedAt < Math.floor(user.passwordChangedAt.getTime() / 1000)
      ) {
        throw new UnauthorizedException('Session expired. Please log in again.');
      }

      // Check if user account is active
      if (user.accountStatus !== 'ACTIVE' && user.accountStatus !== 'SHADOW') {
        throw new UnauthorizedException('Account is not active');
      }

      const pwdChangedAt = user.passwordChangedAt
        ? Math.floor(user.passwordChangedAt.getTime() / 1000)
        : undefined;

      // Generate new tokens (preserve school context from original token)
      const newPayload: JwtPayload = {
        sub: user.id,
        role: user.role,
        ...(payload.schoolId && { schoolId: payload.schoolId }),
        ...(payload.publicId && { publicId: payload.publicId }),
        ...(payload.profileId && { profileId: payload.profileId }),
        ...(payload.contextRole && { contextRole: payload.contextRole }),
        ...(pwdChangedAt !== undefined && { pwdChangedAt }),
      };

      this.metricsService.authTokenRefreshTotal.inc({ status: 'success' });
      return {
        accessToken: this.jwtService.sign(newPayload),
        refreshToken: this.jwtService.sign(newPayload, { expiresIn: '7d' }),
      };
    } catch (error) {
      this.metricsService.authTokenRefreshTotal.inc({ status: 'failed' });
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // Token verification failed (expired, invalid, etc.)
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async validateUser(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        studentProfile: true,
        parentProfile: true,
        teacherProfiles: true,
        schoolAdmins: true,
      },
    });
  }

  /**
   * Request password reset (forgot password). Sends OTP to the account email.
   * Always returns without revealing whether the account exists.
   */
  async requestPasswordReset(requestPasswordResetDto: RequestPasswordResetDto): Promise<void> {
    const identifier = (requestPasswordResetDto.emailOrPublicId || requestPasswordResetDto.email || '').trim();
    if (!identifier) return;

    const user = await this.findUserForPasswordReset(identifier);
    if (!user?.email) return;

    let currentSchoolId: string | null = null;
    if (user.role === 'SCHOOL_ADMIN' && user.schoolAdmins?.length) {
      currentSchoolId = user.schoolAdmins[0].schoolId;
    } else if (user.role === 'TEACHER' && user.teacherProfiles?.length) {
      currentSchoolId = user.teacherProfiles[0].schoolId;
    } else if (user.role === 'STUDENT' && user.studentProfile?.enrollments?.length) {
      currentSchoolId = user.studentProfile.enrollments[0].schoolId;
    }

    if (currentSchoolId) {
      const school = await this.prisma.school.findUnique({
        where: { id: currentSchoolId },
        select: { registrationStatus: true },
      });
      if (school && (school.registrationStatus === 'UNAPPROVED' || school.registrationStatus === 'REJECTED')) {
        this.logger.warn(`[FORGOT_PASSWORD] Skipping OTP for unapproved/rejected school ${currentSchoolId}`);
        return;
      }
    }

    const name = this.getUserDisplayName(user);
    const { otpCode } = await this.passwordOtpService.create('RESET_PASSWORD', user.email, user.id);
    try {
      await this.emailService.sendPasswordResetOtpEmail(user.email, name, otpCode);
    } catch (error) {
      this.logger.error('Failed to send password reset OTP:', error instanceof Error ? error.stack : error);
    }
  }

  /**
   * Look up a user by email or Public ID for forgot-password. Returns null if not found.
   */
  private async findUserForPasswordReset(identifier: string) {
    const include = {
      schoolAdmins: true,
      teacherProfiles: true,
      studentProfile: {
        include: {
          enrollments: {
            where: { isActive: true },
            orderBy: { enrollmentDate: 'desc' as const },
            take: 1,
          },
        },
      },
      parentProfile: true,
    };

    if (identifier.includes('@')) {
      return this.prisma.user.findFirst({
        where: { email: identifier.toLowerCase() },
        include,
      });
    }

    const [admin, teacher, student] = await Promise.all([
      this.prisma.schoolAdmin.findUnique({
        where: { publicId: identifier },
        select: { userId: true },
      }),
      this.prisma.teacher.findUnique({
        where: { publicId: identifier },
        select: { userId: true },
      }),
      this.prisma.student.findUnique({
        where: { publicId: identifier },
        select: { userId: true },
      }),
    ]);

    const userId = admin?.userId || teacher?.userId || student?.userId;
    if (!userId) return null;

    return this.prisma.user.findUnique({
      where: { id: userId },
      include,
    });
  }

  /**
   * Check a setup/reset link token without consuming it.
   */
  async validateResetToken(token: string): Promise<{ valid: boolean; reason?: 'invalid' | 'used' | 'expired' }> {
    if (!token?.trim()) return { valid: false, reason: 'invalid' };

    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token: token.trim() },
      select: { usedAt: true, expiresAt: true },
    });

    if (!resetToken) return { valid: false, reason: 'invalid' };
    if (resetToken.usedAt) return { valid: false, reason: 'used' };

    const bufferMs = 2 * 60 * 1000;
    if (new Date(resetToken.expiresAt) < new Date(Date.now() - bufferMs)) {
      return { valid: false, reason: 'expired' };
    }

    return { valid: true };
  }

  /**
   * Reset password using token
   */
  async resetPassword(resetPasswordDto: ResetPasswordDto): Promise<void> {
    const { token, newPassword } = resetPasswordDto;

    // Find valid reset token
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!resetToken) {
      this.logger.warn(`[RESET_PASSWORD] Token not found: ${token.substring(0, 8)}...`);
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (resetToken.usedAt) {
      this.logger.warn(
        `[RESET_PASSWORD] Token already used at ${resetToken.usedAt.toISOString()} for user ${resetToken.userId}`
      );
      throw new BadRequestException('Reset token has already been used');
    }

    // Check expiration with proper timezone handling and small buffer for clock skew
    const now = new Date();
    const expiresAt = new Date(resetToken.expiresAt);
    // Subtract 2 minute buffer from "now" to account for clock skew between servers
    // This gives a grace period if the server clock is slightly ahead
    const bufferMs = 2 * 60 * 1000; // 2 minutes
    const nowWithBuffer = new Date(now.getTime() - bufferMs);

    this.logger.log(
      `[RESET_PASSWORD] Checking token expiration. Now: ${now.toISOString()}, Now with buffer: ${nowWithBuffer.toISOString()}, Expires: ${expiresAt.toISOString()}`
    );

    if (expiresAt < nowWithBuffer) {
      this.logger.warn(
        `[RESET_PASSWORD] Token expired. Expires: ${expiresAt.toISOString()}, Now: ${now.toISOString()} for user ${resetToken.userId}`
      );
      throw new BadRequestException('Reset token has expired. Please request a new password reset link.');
    }

    await this.assertPasswordMeetsSchoolPolicy(resetToken.userId, newPassword);

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Get user info before updating (for confirmation email)
    const user = resetToken.user;
    let name = user.email || 'User';
    let publicId: string | null = null;

    // Try to get public ID from school admin or teacher profile
    const userWithProfiles = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        schoolAdmins: true,
        teacherProfiles: true,
      },
    });

    if (userWithProfiles) {
      if (userWithProfiles.schoolAdmins && userWithProfiles.schoolAdmins.length > 0) {
        name = `${userWithProfiles.schoolAdmins[0].firstName} ${userWithProfiles.schoolAdmins[0].lastName}`;
        publicId = userWithProfiles.schoolAdmins[0].publicId;
      } else if (userWithProfiles.teacherProfiles && userWithProfiles.teacherProfiles.length > 0) {
        name = `${userWithProfiles.teacherProfiles[0].firstName} ${userWithProfiles.teacherProfiles[0].lastName}`;
        publicId = userWithProfiles.teacherProfiles[0].publicId;
      }
    }

    // Update user password, set passwordChangedAt (invalidate other sessions), mark token as used
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(), // Invalidate all other sessions
          accountStatus: 'ACTIVE', // Activate account if it was shadow
        },
      });

      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      });
    });

    // Get school name for confirmation email
    let schoolName: string | undefined;
    if (userWithProfiles) {
      if (userWithProfiles.schoolAdmins && userWithProfiles.schoolAdmins.length > 0) {
        const school = await this.prisma.school.findUnique({
          where: { id: userWithProfiles.schoolAdmins[0].schoolId },
          select: { name: true },
        });
        schoolName = school?.name;
      } else if (userWithProfiles.teacherProfiles && userWithProfiles.teacherProfiles.length > 0) {
        const school = await this.prisma.school.findUnique({
          where: { id: userWithProfiles.teacherProfiles[0].schoolId },
          select: { name: true },
        });
        schoolName = school?.name;
      }
    }

    // Send confirmation email (only if user has an email)
    if (user.email) {
      try {
        await this.emailService.sendPasswordResetConfirmationEmail(
          user.email,
          name,
          publicId || undefined,
          schoolName
        );
      } catch (error) {
        // Log error but don't fail the request
        this.logger.error(
          'Failed to send password reset confirmation email:',
          error instanceof Error ? error.stack : error
        );
      }
    }
  }

  /**
   * Resend password reset email using the original (possibly expired) token.
   * Looks up the userId from the token record — no email input required.
   * Rate-limited: only works if the original token was generated within the last 7 days.
   */
  async resendPasswordResetByToken(token: string): Promise<void> {
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token },
      select: { userId: true, createdAt: true },
    });

    if (!resetToken) {
      // Don't reveal whether the token existed — always succeed silently
      this.logger.warn(`[RESEND_BY_TOKEN] Token not found: ${token.substring(0, 8)}...`);
      return;
    }

    // Reject tokens older than 7 days (prevents abuse of ancient links)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (resetToken.createdAt < sevenDaysAgo) {
      this.logger.warn(`[RESEND_BY_TOKEN] Token too old for user ${resetToken.userId}`);
      return;
    }

    await this.resendPasswordResetEmail(resetToken.userId);
  }

  /**
   * Generate and send password reset token for new user (used when creating school/admin/teacher)
   */
  async sendPasswordResetForNewUser(
    userId: string,
    email: string,
    name: string,
    role: string,
    publicId?: string,
    schoolName?: string,
    studentUid?: string, // For students: show in signup email for their records
    schoolId?: string | null,
  ): Promise<void> {
    await this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setTime(expiresAt.getTime() + 24 * 60 * 60 * 1000); // 24 hours for new user activation

    await this.prisma.passwordResetToken.create({
      data: {
        token,
        userId,
        expiresAt,
      },
    });

    try {
      await this.emailService.sendPasswordResetEmail(
        email,
        name,
        token,
        role,
        undefined,
        publicId || undefined,
        schoolName,
        studentUid,
        schoolId,
        'setup',
      );
    } catch (error) {
      // Log error but don't fail the request
      this.logger.error(
        'Failed to send password reset email:',
        error instanceof Error ? error.stack : error
      );
    }
  }

  /**
   * Resend password reset email for a user (admin function)
   * Invalidates any existing unused tokens and creates a new one
   */
  async resendPasswordResetEmail(userId: string, schoolId?: string): Promise<void> {
    // Get user with profiles
    // If schoolId is provided, filter by it; otherwise get all schools
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        schoolAdmins: schoolId
          ? {
            where: { schoolId },
            include: {
              school: {
                select: { name: true },
              },
            },
          }
          : {
            include: {
              school: {
                select: { name: true },
              },
            },
          },
        teacherProfiles: schoolId
          ? {
            where: { schoolId },
            include: {
              school: {
                select: { name: true },
              },
            },
          }
          : {
            include: {
              school: {
                select: { name: true },
              },
            },
          },
        studentProfile: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.email) {
      throw new BadRequestException('User does not have an email address');
    }

    // Invalidate any existing unused tokens for this user
    await this.prisma.passwordResetToken.updateMany({
      where: {
        userId,
        usedAt: null,
      },
      data: {
        usedAt: new Date(), // Mark as used to invalidate
      },
    });

    // Get user name, role, and ALL schools/profiles for multi-school users
    let name = user.email;
    let role = 'User';
    const schools: Array<{ name: string; publicId: string; role: string }> = [];

    // Collect ALL school admin profiles (or filtered by schoolId if provided)
    if (user.schoolAdmins && user.schoolAdmins.length > 0) {
      name = `${user.schoolAdmins[0].firstName} ${user.schoolAdmins[0].lastName}`;
      role = 'Administrator';

      for (const admin of user.schoolAdmins) {
        if (admin.school) {
          schools.push({
            name: admin.school.name,
            publicId: admin.publicId,
            role: admin.role === 'Principal' ? 'Principal' : 'Administrator',
          });
        }
      }
    }
    // Collect ALL teacher profiles (or filtered by schoolId if provided)
    else if (user.teacherProfiles && user.teacherProfiles.length > 0) {
      name = `${user.teacherProfiles[0].firstName} ${user.teacherProfiles[0].lastName}`;
      role = 'Teacher';

      for (const teacher of user.teacherProfiles) {
        if (teacher.school) {
          schools.push({
            name: teacher.school.name,
            publicId: teacher.publicId,
            role: 'Teacher',
          });
        }
      }
    }
    // Students - single school only
    else if (user.studentProfile) {
      name = `${user.studentProfile.firstName} ${user.studentProfile.lastName}`;
      role = 'Student';

      // Get school name from student's enrollment
      const enrollment = await this.prisma.enrollment.findFirst({
        where: {
          studentId: user.studentProfile.id,
          isActive: true,
        },
        include: {
          school: {
            select: { name: true },
          },
        },
        orderBy: {
          enrollmentDate: 'desc',
        },
      });

      if (enrollment?.school && user.studentProfile.publicId) {
        schools.push({
          name: enrollment.school.name,
          publicId: user.studentProfile.publicId,
          role: 'Student',
        });
      }
    }

    // Generate new reset token with proper expiration
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setTime(expiresAt.getTime() + 24 * 60 * 60 * 1000); // 24 hours for resent activation

    this.logger.log(
      `[RESEND_PASSWORD_RESET] Creating new token for user ${userId}, expires at: ${expiresAt.toISOString()}`
    );

    // Create new reset token
    await this.prisma.passwordResetToken.create({
      data: {
        token,
        userId,
        expiresAt,
      },
    });

    this.logger.log(
      `[RESEND_PASSWORD_RESET] New token created successfully for user ${userId}`
    );

    // Send email with all schools information
    try {
      await this.emailService.sendPasswordResetEmail(
        user.email,
        name,
        token,
        role,
        schools.length > 0 ? schools : undefined,
        undefined,
        undefined,
        undefined,
        schoolId,
        user.passwordHash ? 'reset' : 'setup',
      );
    } catch (error) {
      // Log error but don't fail the request
      this.logger.error(
        'Failed to resend password reset email:',
        error instanceof Error ? error.stack : error
      );
      throw error; // Re-throw so admin knows it failed
    }
  }

  /**
   * Step 1: Request password change (sends OTP to email). Authenticated user must provide current password.
   */
  async requestChangePassword(
    userId: string,
    dto: RequestChangePasswordDto,
  ): Promise<{ sessionId: string }> {
    const currentPassword = dto.currentPassword.trim();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.email) throw new BadRequestException('User has no email address');
    if (!user.passwordHash) throw new BadRequestException('User does not have a password set. Use password reset instead.');
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const { sessionId, otpCode } = await this.passwordOtpService.create(
      'CHANGE_PASSWORD',
      user.email,
      userId,
    );
    const name = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
    await this.emailService.sendPasswordChangeOtpEmail(user.email, name, otpCode);
    return { sessionId };
  }

  /**
   * Step 2: Confirm password change with OTP. Updates password, sets passwordChangedAt, sends confirmation, invalidates other sessions.
   */
  async confirmChangePasswordWithOtp(dto: ConfirmChangePasswordDto): Promise<void> {
    const { userId, email } = await this.passwordOtpService.verifyChangePassword(
      dto.sessionId,
      dto.otpCode,
    );
    await this.assertPasswordMeetsSchoolPolicy(userId, dto.newPassword.trim());
    const newPasswordHash = await bcrypt.hash(dto.newPassword.trim(), 10);
    await this.applyPasswordUpdateAndNotify(userId, newPasswordHash, email, 'change');
  }

  /**
   * Verify reset-password OTP and set new password. Invalidates other sessions and sends confirmation.
   */
  async verifyResetPasswordWithOtp(dto: VerifyResetPasswordDto): Promise<void> {
    const identifier = (dto.emailOrPublicId || dto.email || '').trim();
    if (!identifier) {
      throw new BadRequestException('Invalid or expired verification. Please request a new code.');
    }
    const user = await this.findUserForPasswordReset(identifier);
    if (!user?.email) {
      throw new BadRequestException('Invalid or expired verification. Please request a new code.');
    }
    const { userId, email } = await this.passwordOtpService.verifyResetPassword(
      user.email,
      dto.otpCode,
    );
    await this.assertPasswordMeetsSchoolPolicy(userId, dto.newPassword.trim());
    const newPasswordHash = await bcrypt.hash(dto.newPassword.trim(), 10);
    await this.applyPasswordUpdateAndNotify(userId, newPasswordHash, email, 'reset');
  }

  /**
   * Enforce school password policy when it is stricter than DTO mins.
   */
  private async assertPasswordMeetsSchoolPolicy(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        schoolAdmins: { select: { schoolId: true } },
        teacherProfiles: { select: { schoolId: true } },
        studentProfile: {
          select: {
            enrollments: { where: { isActive: true }, select: { schoolId: true } },
          },
        },
      },
    });
    const schoolIds = new Set<string>();
    user?.schoolAdmins?.forEach((a) => schoolIds.add(a.schoolId));
    user?.teacherProfiles?.forEach((t) => schoolIds.add(t.schoolId));
    user?.studentProfile?.enrollments?.forEach((e) => schoolIds.add(e.schoolId));
    if (schoolIds.size === 0) return;

    let minLength = 8;
    let requireSpecial = false;
    for (const schoolId of schoolIds) {
      try {
        const policy = await this.schoolSettingsService.getSecurityPolicy(schoolId);
        minLength = Math.max(minLength, policy.passwordMinLength ?? 8);
        requireSpecial = requireSpecial || !!policy.passwordRequireSpecialChar;
      } catch {
        // Missing policy should not block password changes.
      }
    }
    if (password.length < minLength) {
      throw new BadRequestException(`Password must be at least ${minLength} characters long.`);
    }
    if (requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
      throw new BadRequestException('Password must contain at least one special character.');
    }
  }

  /**
   * Update password, set passwordChangedAt (invalidates other sessions), send confirmation email.
   */
  private async applyPasswordUpdateAndNotify(
    userId: string,
    newPasswordHash: string,
    email: string,
    kind: 'change' | 'reset',
  ): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newPasswordHash,
        passwordChangedAt: new Date(),
        ...(kind === 'reset' ? { accountStatus: 'ACTIVE' } : {}),
      },
      select: { firstName: true, lastName: true },
    });
    const name = updated.firstName && updated.lastName ? `${updated.firstName} ${updated.lastName}` : email;
    this.logger.log(`[PASSWORD_${kind.toUpperCase()}] User ${email} (${userId}) – password updated, other sessions invalidated`);
    try {
      await this.emailService.sendPasswordResetConfirmationEmail(email, name);
    } catch (error) {
      this.logger.error('Failed to send password confirmation email:', error instanceof Error ? error.stack : error);
    }
  }

  private getUserDisplayName(user: {
    email: string | null;
    firstName?: string | null;
    lastName?: string | null;
    schoolAdmins?: { firstName: string; lastName: string }[];
    teacherProfiles?: { firstName: string; lastName: string }[];
    studentProfile?: { firstName: string; lastName: string } | null;
    parentProfile?: { firstName: string; lastName: string } | null;
  }): string {
    if (user.schoolAdmins?.length) return `${user.schoolAdmins[0].firstName} ${user.schoolAdmins[0].lastName}`;
    if (user.teacherProfiles?.length) return `${user.teacherProfiles[0].firstName} ${user.teacherProfiles[0].lastName}`;
    if (user.studentProfile) return `${user.studentProfile.firstName} ${user.studentProfile.lastName}`;
    if (user.parentProfile) return `${user.parentProfile.firstName} ${user.parentProfile.lastName}`;
    if (user.firstName && user.lastName) return `${user.firstName} ${user.lastName}`;
    return user.email ?? 'there';
  }

  /**
   * Change password (legacy single-step). Prefer requestChangePassword + confirmChangePasswordWithOtp for OTP verification.
   */
  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
  ): Promise<void> {
    const { currentPassword, newPassword } = changePasswordDto;
    const sanitizedCurrent = currentPassword.trim();
    const sanitizedNew = newPassword.trim();
    if (sanitizedCurrent === sanitizedNew) {
      throw new BadRequestException('New password must be different from current password');
    }
    await this.assertPasswordMeetsSchoolPolicy(userId, sanitizedNew);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, firstName: true, lastName: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.passwordHash) throw new BadRequestException('User does not have a password set. Use password reset instead.');
    const valid = await bcrypt.compare(sanitizedCurrent, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');
    const newPasswordHash = await bcrypt.hash(sanitizedNew, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash, passwordChangedAt: new Date() },
    });
    this.logger.log(`[PASSWORD_CHANGE] User ${user.email} (${userId}) changed password (legacy flow)`);
    if (user.email) {
      const name = user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email;
      try {
        await this.emailService.sendPasswordResetConfirmationEmail(user.email, name);
      } catch (error) {
        this.logger.error('Failed to send confirmation email:', error instanceof Error ? error.stack : error);
      }
    }
  }

  /**
   * Upload super admin profile image
   * Security: Validates file type, size, and sanitizes filename
   */
  async uploadProfileImage(
    userId: string,
    file: Express.Multer.File
  ): Promise<{ profileImage: string }> {
    // Get user and verify role
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Access denied. SUPER_ADMIN role required.');
    }

    // Validate file exists
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type - only allow image formats
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed'
      );
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds maximum limit of 5MB');
    }

    // Additional security: Validate file buffer is actually an image
    // Check magic bytes (file signature) to prevent malicious file uploads
    const buffer = file.buffer;
    const isValidImage = this.validateImageFile(buffer, file.mimetype);
    if (!isValidImage) {
      throw new BadRequestException('File is not a valid image. Malicious files are not allowed.');
    }

    // Delete old image if exists
    if ((user as any).profileImage && (user as any).publicId) {
      try {
        await this.cloudinaryService.deleteImage((user as any).publicId);
      } catch (error) {
        this.logger.error(
          'Error deleting old profile image:',
          error instanceof Error ? error.stack : error
        );
        // Continue even if deletion fails
      }
    }

    // Generate safe public ID (sanitize to prevent injection)
    const safePublicId = `super-admin-${user.id}`;

    // Upload to Cloudinary with error handling and timeout
    let url: string;
    let publicId: string;

    try {
      // Add timeout wrapper (30 seconds)
      const uploadPromise = this.cloudinaryService.uploadImage(
        file,
        'users/super-admin',
        safePublicId
      );

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Upload timeout: Cloudinary did not respond within 30 seconds'));
        }, 30000); // 30 second timeout
      });

      const uploadResult = await Promise.race([uploadPromise, timeoutPromise]) as { url: string; publicId: string };
      url = uploadResult.url;
      publicId = uploadResult.publicId;
    } catch (error: any) {
      this.logger.error(
        `[PROFILE_IMAGE] Cloudinary upload failed for user ${user.id}:`,
        error instanceof Error ? error.stack : error
      );

      // Re-throw with more context
      if (error?.http_code === 499 || error?.name === 'TimeoutError' || error?.message?.includes('timeout')) {
        throw new BadRequestException(
          'Image upload timed out. Please try again with a smaller image or check your internet connection.'
        );
      }

      if (error?.message?.includes('Cloudinary is not configured') || error?.message?.includes('CLOUDINARY')) {
        throw new BadRequestException(
          'Image upload service is not configured. Please contact support.'
        );
      }

      throw new BadRequestException(
        `Failed to upload image: ${error?.message || 'Unknown error'}. Please try again.`
      );
    }

    // Update user with new image URL and public ID
    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          profileImage: url,
          publicId: publicId,
        } as any, // Type assertion needed until Prisma client is regenerated
      });
    } catch (error: any) {
      this.logger.error(
        `[PROFILE_IMAGE] Failed to update user ${user.id} with new image URL:`,
        error instanceof Error ? error.stack : error
      );
      // Image was uploaded but we couldn't save the URL - this is bad but we'll still return success
      // The image exists in Cloudinary but won't be linked to the user
      throw new BadRequestException(
        'Image uploaded but failed to save. Please try uploading again.'
      );
    }

    this.logger.log(`[PROFILE_IMAGE] Super admin ${user.id} uploaded profile image successfully`);

    return { profileImage: url };
  }

  /**
   * Validate image file by checking magic bytes (file signature)
   * This prevents malicious files from being uploaded even if they have image extensions
   */
  private validateImageFile(buffer: Buffer, mimeType: string): boolean {
    if (!buffer || buffer.length < 4) {
      return false;
    }

    // Check magic bytes for different image formats
    const signatures: { [key: string]: number[][] } = {
      'image/jpeg': [[0xff, 0xd8, 0xff]],
      'image/jpg': [[0xff, 0xd8, 0xff]],
      'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]], // GIF87a or GIF89a
      'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF header (WebP starts with RIFF)
    };

    const expectedSignatures = signatures[mimeType];
    if (!expectedSignatures) {
      return false;
    }

    // Check if buffer matches any of the expected signatures
    for (const signature of expectedSignatures) {
      let matches = true;
      for (let i = 0; i < signature.length; i++) {
        if (buffer[i] !== signature[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return true;
      }
    }

    // For WebP, also check for WEBP string after RIFF header
    if (mimeType === 'image/webp') {
      if (buffer.length < 12) {
        return false;
      }
      const webpString = buffer.toString('ascii', 8, 12);
      return webpString === 'WEBP';
    }

    return false;
  }

  /**
   * Get login sessions for a user (history)
   */
  async getLoginSessions(userId: string) {
    return this.prisma.loginSession.findMany({
      where: {
        userId,
        usedAt: { not: null },
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          }
        }
      },
      orderBy: {
        usedAt: 'desc',
      },
      take: 50, // Increased limit to allow for better grouping
    });
  }
}
