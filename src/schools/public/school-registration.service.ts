import { Injectable, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { EmailService } from '../../email/email.service';
import { IdGeneratorService } from '../shared/id-generator.service';
import { SchoolValidatorService } from '../shared/school-validator.service';
import { RegisterSchoolDto, RegisterSchoolResponseDto } from '../dto/register-school.dto';
import { generateSecurePasswordHash } from '../../common/utils/password.utils';
import { PortalsService } from '../../portals/portals.service';
import { AdminAccessTier } from '../dto/permission.dto';

@Injectable()
export class SchoolRegistrationService {
    private readonly logger = new Logger(SchoolRegistrationService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly emailService: EmailService,
        private readonly idGenerator: IdGeneratorService,
        private readonly schoolValidator: SchoolValidatorService,
        private readonly portals: PortalsService,
    ) { }

    /**
     * Register a new school (public, no auth required).
     * Creates school + principal user in PENDING state.
     * No password is generated — that happens on verification.
     */
    async registerSchool(dto: RegisterSchoolDto): Promise<RegisterSchoolResponseDto> {
        const {
            schoolName,
            schoolEmail,
            schoolPhone,
            address,
            city,
            state,
            country,
            levels,
            owner,
            registrationNote,
            slug: requestedSlug,
        } = dto;

        // 1. Sanitize inputs
        const sanitizedName = this.sanitizeString(schoolName, 3, 200);
        const sanitizedSchoolEmail = schoolEmail.toLowerCase().trim();
        const sanitizedOwnerEmail = owner.email.toLowerCase().trim();

        // 2. Validate at least one level selected
        if (!levels.primary && !levels.secondary && !levels.tertiary) {
            throw new BadRequestException('Please select at least one school level (Primary, Secondary, or Tertiary).');
        }

        // 3. Check for duplicate school name (loose match)
        const existingSchool = await this.prisma.school.findFirst({
            where: {
                name: { equals: sanitizedName, mode: 'insensitive' },
                registrationStatus: { not: 'REJECTED' },
            },
        });
        if (existingSchool) {
            throw new ConflictException(
                'A school with this name already exists or has a pending application. Please contact support if you believe this is an error.',
            );
        }

        // 4. Check if user email already exists (for the owner)
        const existingUser = await this.prisma.user.findUnique({
            where: { email: sanitizedOwnerEmail },
        });
        if (existingUser) {
            throw new ConflictException(
                'An account with this email already exists. If you already registered, please wait for verification or contact support.',
            );
        }

        let reservedSlug: string | null = null;
        if (requestedSlug && requestedSlug.trim()) {
            reservedSlug = await this.portals.reserveSlug(requestedSlug);
        }

        // 5. Generate IDs
        const schoolId = await this.idGenerator.generateSchoolId();
        const ownerAdminId = await this.idGenerator.generatePrincipalId();
        const ownerPublicId = await this.idGenerator.generatePublicId(sanitizedName, 'admin');

        // 7. Generate a placeholder password hash (user will never use this — they set password on verification)
        const placeholderPasswordHash = await generateSecurePasswordHash();

        try {
            // 8. Create school + principal in a transaction
            const result = await this.prisma.$transaction(async (tx) => {
                // Create the school (PENDING, not active)
                const school = await tx.school.create({
                    data: {
                        name: sanitizedName,
                        schoolId,
                        email: sanitizedSchoolEmail,
                        phone: schoolPhone.trim(),
                        address: address?.trim() || null,
                        city: city?.trim() || null,
                        state: state?.trim() || null,
                        country: country?.trim() || 'Nigeria',
                        hasPrimary: levels.primary || false,
                        hasSecondary: levels.secondary || false,
                        hasTertiary: levels.tertiary || false,
                        isActive: false, // Not active until verified
                        registrationStatus: 'UNAPPROVED',
                        registrationNote: registrationNote?.trim() || null,
                        slug: reservedSlug,
                    },
                });

                // Create the owner user (SHADOW — no password until verification)
                const user = await tx.user.create({
                    data: {
                        email: sanitizedOwnerEmail,
                        phone: owner.phone.trim(),
                        passwordHash: placeholderPasswordHash,
                        accountStatus: 'SHADOW',
                        role: 'SCHOOL_ADMIN',
                        firstName: owner.firstName.trim(),
                        lastName: owner.lastName.trim(),
                    },
                });

                // Create the SchoolAdmin record (principal role)
                await tx.schoolAdmin.create({
                    data: {
                        adminId: ownerAdminId,
                        publicId: ownerPublicId,
                        firstName: owner.firstName.trim(),
                        lastName: owner.lastName.trim(),
                        phone: owner.phone.trim(),
                        role: 'school_owner',
                        // The owner must never be locked out of their own school.
                        accessTier: AdminAccessTier.PRINCIPAL,
                        schoolId: school.id,
                        userId: user.id,
                    },
                });

                return { school, user };
            });

            // 9. Send "Registration Received" email to the owner
            try {
                await this.emailService.sendRegistrationReceivedEmail(
                    sanitizedOwnerEmail,
                    sanitizedName,
                    `${owner.firstName.trim()} ${owner.lastName.trim()}`,
                );
            } catch (emailErr) {
                this.logger.warn(`Failed to send registration email to ${sanitizedOwnerEmail}: ${emailErr.message}`);
            }

            // 10. Notify Super Admin about new registration
            try {
                await this.notifySuperAdmin(sanitizedName, sanitizedOwnerEmail, owner.firstName.trim(), result.school.id);
            } catch (emailErr) {
                this.logger.warn(`Failed to notify super admin about new registration: ${emailErr.message}`);
            }

            this.logger.log(`New school registration: ${sanitizedName} (${result.school.id})`);

            return {
                schoolName: sanitizedName,
                email: sanitizedOwnerEmail,
                message: 'Your school registration has been received. You will receive an email once your account is verified.',
            };
        } catch (error) {
            if (error instanceof ConflictException || error instanceof BadRequestException) {
                throw error;
            }
            this.logger.error(`Failed to register school: ${error.message}`, error.stack);
            throw new BadRequestException('An error occurred during registration. Please try again.');
        }
    }

    /**
     * Notify super admin(s) about a new school registration
     */
    private async notifySuperAdmin(schoolName: string, principalEmail: string, principalFirstName: string, schoolId: string): Promise<void> {
        const superAdmins = await this.prisma.user.findMany({
            where: { role: 'SUPER_ADMIN', accountStatus: 'ACTIVE' },
            select: { email: true, firstName: true },
        });

        for (const admin of superAdmins) {
            if (admin.email) {
                try {
                    await this.emailService.sendNewRegistrationNotificationEmail(
                        admin.email,
                        admin.firstName || 'Admin',
                        schoolName,
                        principalEmail,
                        principalFirstName,
                        schoolId, // Pass the school ID for direct access
                    );
                } catch (err) {
                    this.logger.warn(`Failed to notify super admin ${admin.email}: ${err.message}`);
                }
            }
        }
    }

    // ──── Utility Methods ────

    private sanitizeString(input: string, minLength: number = 0, maxLength: number = 1000): string {
        if (!input) return '';
        let sanitized = input.trim();
        sanitized = sanitized.replace(/<[^>]*>/g, '');
        sanitized = sanitized.replace(/[<>"'`\\;]/g, '');
        sanitized = sanitized.replace(/\s+/g, ' ');
        if (sanitized.length < minLength) {
            throw new BadRequestException(`Input must be at least ${minLength} characters`);
        }
        return sanitized.slice(0, maxLength);
    }

}
