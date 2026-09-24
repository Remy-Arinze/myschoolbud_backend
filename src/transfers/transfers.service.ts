import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import {
  GenerateTacDto,
  InitiateTransferDto,
  CompleteTransferDto,
  RejectTransferDto,
} from './dto/transfer.dto';
import { TransferStatus, TermStatus, SessionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { NotificationService } from '../notification/notification.service';
import { SchoolSettingsService } from '../school-settings/school-settings.service';

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly notificationService: NotificationService,
    private readonly schoolSettingsService: SchoolSettingsService,
  ) {}

  /**
   * Compute letter grade from percentage
   */
  private getLetterGrade(percentage: number): string {
    if (percentage >= 70) return 'A';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
  }

  /**
   * Generate a unique TAC (Transfer Access Code) for outgoing transfer
   */
  async generateTac(schoolId: string, userId: string, dto: GenerateTacDto) {
    const admissionPolicy = await this.schoolSettingsService.getAdmissionPolicy(schoolId);
    if (admissionPolicy.transferPolicy === 'DISABLED') {
      throw new BadRequestException('Transfers are disabled for this school.');
    }

    // Get school info for email
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });

    // Verify student exists and belongs to this school
    const student = await this.prisma.student.findFirst({
      where: {
        id: dto.studentId,
        enrollments: {
          some: {
            schoolId,
            isActive: true,
          },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
          },
        },
        enrollments: {
          where: {
            schoolId,
            isActive: true,
          },
          take: 1,
        },
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found or not enrolled in this school');
    }

    // Check if there's already an active TAC for this student
    const existingTransfer = await this.prisma.transfer.findFirst({
      where: {
        studentId: dto.studentId,
        fromSchoolId: schoolId,
        status: { in: ['PENDING', 'APPROVED'] },
        tac: { not: null },
        OR: [{ tacExpiresAt: { gt: new Date() } }, { tacUsedAt: null }],
      },
    });

    if (existingTransfer && existingTransfer.tac && !existingTransfer.tacUsedAt) {
      const expiresAt = existingTransfer.tacExpiresAt;

      // Send email if student has email
      const studentEmail = student.user?.email;
      if (studentEmail && school) {
        try {
          await this.emailService.sendTransferInitiationEmail(
            studentEmail,
            `${student.firstName} ${student.lastName}`,
            existingTransfer.tac,
            student.id,
            school.name,
            expiresAt
          );
        } catch (error) {
          // Log error but don't fail the request
          this.logger.error(
            'Failed to send transfer initiation email:',
            error instanceof Error ? error.stack : error
          );
        }
      } else if (!studentEmail) {
        console.warn(
          `Student ${student.id} does not have an email address. Cannot send transfer notification.`
        );
      }

      return {
        transferId: existingTransfer.id,
        tac: existingTransfer.tac,
        studentId: student.id,
        studentName: `${student.firstName} ${student.lastName}`,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        message: existingTransfer.kind === 'SCHOOL_CLOSURE'
          ? 'This transfer code does not expire'
          : 'Share this TAC with the receiving school',
      };
    }

    // Generate unique TAC
    const tac = await this.generateUniqueTac();
    const expiryDays = admissionPolicy.tacExpiryDays ?? 30;

    // Create transfer record
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiryDays);

    const transfer = await this.prisma.transfer.create({
      data: {
        studentId: dto.studentId,
        fromSchoolId: schoolId,
        toSchoolId: null,
        status: TransferStatus.PENDING,
        tac,
        tacGeneratedAt: new Date(),
        tacExpiresAt: expiresAt,
        reason: dto.reason,
        requestedBy: userId,
      },
      include: {
        student: true,
      },
    });

    // Send email to student if email exists
    const studentEmail = student.user?.email;
    if (studentEmail && school) {
      try {
        await this.emailService.sendTransferInitiationEmail(
          studentEmail,
          `${student.firstName} ${student.lastName}`,
          tac,
          student.id,
          school.name,
          expiresAt
        );
      } catch (error) {
        // Log error but don't fail the request
        console.error('Failed to send transfer initiation email:', error);
      }
    } else if (!studentEmail) {
      console.warn(
        `Student ${student.id} does not have an email address. Cannot send transfer notification.`
      );
    }

    try {
      const studentUserId = student.user?.id;
      if (studentUserId) {
        void this.notificationService.notifyUsers([studentUserId], {
          schoolId,
          role: 'STUDENT',
          type: 'TRANSFER_INITIATED',
          title: 'Transfer started',
          subtitle: 'A transfer code was sent to your email',
          body: 'Use the code from your email to complete the transfer. The code is not shown here.',
          link: '/dashboard/student/applications',
          metadata: { transferId: transfer.id, expiresAt: expiresAt.toISOString() },
        });
      }
    } catch {
      // Transfer initiation must not depend on notification delivery.
    }

    return {
      transferId: transfer.id,
      tac: transfer.tac!,
      studentId: student.id,
      studentName: `${student.firstName} ${student.lastName}`,
      expiresAt: expiresAt.toISOString(),
      message: 'Share this TAC with the receiving school',
    };
  }

  /**
   * Generate a unique TAC code
   * Format: TAC-{8 chars}-{4 chars}
   */
  private async generateUniqueTac(): Promise<string> {
    let tac: string;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isUnique && attempts < maxAttempts) {
      // Generate 8 random alphanumeric characters
      const part1 = randomBytes(4).toString('hex').toUpperCase().substring(0, 8);
      // Generate 4 random alphanumeric characters
      const part2 = randomBytes(2).toString('hex').toUpperCase().substring(0, 4);
      tac = `TAC-${part1}-${part2}`;

      // Check if TAC already exists
      const existing = await this.prisma.transfer.findUnique({
        where: { tac },
      });

      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      throw new BadRequestException('Failed to generate unique TAC. Please try again.');
    }

    return tac!;
  }

  /**
   * Issue never-expiring SCHOOL_CLOSURE TACs after deactivate.
   * Failures are logged; they must never block school deactivation.
   */
  async issueClosureTacsForSchool(schoolId: string): Promise<void> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { schoolId, isActive: true },
      include: {
        student: { include: { user: { select: { email: true, firstName: true } } } },
      },
    });

    for (const enrollment of enrollments) {
      try {
        await this.ensureClosureTac(enrollment.studentId, schoolId, enrollment);
      } catch (err: any) {
        this.logger.error(
          `Closure TAC failed for student ${enrollment.studentId}: ${err?.message || err}`,
        );
      }
    }
  }

  async ensureClosureTacForStudent(studentId: string, schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { lifecycleStatus: true, isActive: true },
    });
    if (!school || (school.lifecycleStatus !== 'DEACTIVATED' && school.isActive)) {
      throw new BadRequestException('Closure transfer codes are only available after a school is deactivated.');
    }

    const enrollment = await this.prisma.enrollment.findFirst({
      where: { studentId, schoolId, isActive: true },
      include: {
        student: { include: { user: { select: { email: true, firstName: true } } } },
      },
    });
    if (!enrollment) {
      throw new NotFoundException('No active enrollment at this school.');
    }
    return this.ensureClosureTac(studentId, schoolId, enrollment);
  }

  private async ensureClosureTac(
    studentId: string,
    schoolId: string,
    enrollment: {
      id: string;
      student: { user: { email: string | null; firstName: string | null } | null } | null;
    },
  ) {
    const existing = await this.prisma.transfer.findFirst({
      where: {
        studentId,
        fromSchoolId: schoolId,
        kind: 'SCHOOL_CLOSURE',
        tacUsedAt: null,
        status: { in: ['PENDING', 'APPROVED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        id: existing.id,
        tac: existing.tac,
        status: existing.status,
        kind: existing.kind,
        createdAt: existing.createdAt,
      };
    }

    const tac = await this.generateUniqueTac();
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });
    const transfer = await this.prisma.transfer.create({
      data: {
        studentId,
        fromSchoolId: schoolId,
        kind: 'SCHOOL_CLOSURE',
        tac,
        tacGeneratedAt: new Date(),
        tacExpiresAt: null,
        status: 'PENDING',
      },
    });

    const email = enrollment.student?.user?.email;
    if (email && school) {
      try {
        await this.emailService.sendTransferInitiationEmail(
          email,
          enrollment.student?.user?.firstName || 'Student',
          tac,
          studentId,
          school.name,
          null,
        );
      } catch (err: any) {
        this.logger.warn(`Closure TAC email failed for ${email}: ${err?.message || err}`);
      }
    }

    return {
      id: transfer.id,
      tac: transfer.tac,
      status: transfer.status,
      kind: transfer.kind,
      createdAt: transfer.createdAt,
    };
  }

  /**
   * Validate TAC and initiate transfer
   */
  async initiateTransfer(schoolId: string, dto: InitiateTransferDto) {
    const destPolicy = await this.schoolSettingsService.getAdmissionPolicy(schoolId);
    if (destPolicy.transferPolicy === 'DISABLED') {
      throw new BadRequestException('This school is not accepting incoming transfers.');
    }

    // Find transfer by TAC
    const transfer = await this.prisma.transfer.findUnique({
      where: { tac: dto.tac },
      include: {
        student: true,
        fromSchool: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException('Invalid TAC. Please verify the code and try again.');
    }

    // Validate TAC
    // Check if TAC has already been used (completed transfer)
    if (transfer.tacUsedAt) {
      throw new ConflictException(
        `This TAC has already been used by ${transfer.tacUsedBy ? 'another school' : 'a school'} on ${transfer.tacUsedAt.toISOString()}.`
      );
    }

    // Another school initiated but did not complete — release so this school can take over.
    if (transfer.toSchoolId && transfer.toSchoolId !== schoolId) {
      if (transfer.status === TransferStatus.COMPLETED) {
        throw new ConflictException(
          `This TAC has already been used by ${transfer.tacUsedBy ? 'another school' : 'a school'}.`
        );
      }
    }

    if (transfer.tacExpiresAt && transfer.tacExpiresAt < new Date()) {
      throw new BadRequestException(
        'This TAC has expired. Please request a new one from the source school.'
      );
    }

    if (transfer.studentId !== dto.studentId) {
      throw new BadRequestException('Student ID does not match the TAC.');
    }

    if (transfer.fromSchoolId === schoolId) {
      throw new BadRequestException('Cannot transfer within the same school.');
    }

    // Validate TAC and studentId exist
    if (!transfer.tac || !transfer.studentId) {
      throw new BadRequestException('Transfer TAC or student ID is missing');
    }

    // Get student data from source school
    const studentData = await this.getStudentDataByTac(transfer.tac, transfer.studentId);

    // Update transfer record - Set toSchoolId and status, but DON'T mark TAC as used yet
    // TAC will only be marked as used when transfer is successfully completed
    const updatedTransfer = await this.prisma.transfer.update({
      where: { id: transfer.id },
      data: {
        toSchoolId: schoolId,
        status: TransferStatus.APPROVED, // Auto-approve
        approvedAt: new Date(),
        // Note: tacUsedAt and tacUsedBy are NOT set here - only set after successful completion
      },
    });

    if (destPolicy.transferPolicy === 'AUTO_ACCEPT') {
      const classLevel = studentData.enrollment?.classLevel;
      const academicYear = studentData.enrollment?.academicYear;
      if (classLevel && academicYear) {
        await this.completeTransfer(schoolId, updatedTransfer.id, {
          targetClassLevel: classLevel,
          academicYear,
        });
        return {
          transferId: updatedTransfer.id,
          studentData,
          message: 'Transfer auto-accepted and completed',
        };
      }
      return {
        transferId: updatedTransfer.id,
        studentData,
        message: 'Transfer auto-accepted. Assign a class to complete enrollment.',
      };
    }

    return {
      transferId: updatedTransfer.id,
      studentData,
      message: 'Review student data and complete transfer',
    };
  }

  /**
   * Get student data using TAC (cross-school access)
   * This bypasses normal school isolation
   */
  async getStudentDataByTac(tac: string, studentId: string) {
    // Validate TAC first
    const transfer = await this.prisma.transfer.findUnique({
      where: { tac },
      include: {
        fromSchool: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException('Invalid TAC');
    }

    if (transfer.studentId !== studentId) {
      throw new BadRequestException('Student ID does not match TAC');
    }

    // Get student with ALL enrollments from source school (not just active)
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        user: {
          select: {
            email: true,
            phone: true,
          },
        },
        enrollments: {
          where: {
            schoolId: transfer.fromSchoolId,
          },
          orderBy: {
            enrollmentDate: 'desc',
          },
          include: {
            grades: {
              orderBy: [{ academicYear: 'desc' }, { term: 'desc' }, { createdAt: 'desc' }],
            },
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    if (student.enrollments.length === 0) {
      throw new NotFoundException('Student has no enrollment in source school');
    }

    // Get active enrollment for backward compatibility
    const activeEnrollment = student.enrollments.find((e) => e.isActive) || student.enrollments[0];

    // Map all enrollments with their grades grouped by class level
    const enrollments = student.enrollments.map((enrollment) => ({
      id: enrollment.id,
      classLevel: enrollment.classLevel,
      academicYear: enrollment.academicYear,
      enrollmentDate: enrollment.enrollmentDate.toISOString(),
      isActive: enrollment.isActive,
      grades: enrollment.grades.map((grade) => {
        const score = grade.score.toNumber();
        const maxScore = grade.maxScore.toNumber();
        const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
        return {
          id: grade.id,
          subject: grade.subject || 'N/A', // Ensure subject is never null
          gradeType: grade.gradeType,
          assessmentName: grade.assessmentName,
          sequence: grade.sequence,
          assessmentDate: grade.assessmentDate?.toISOString(),
          score,
          maxScore,
          grade: this.getLetterGrade(percentage),
          term: grade.term,
          academicYear: grade.academicYear,
          remarks: grade.remarks,
          signedAt: grade.signedAt?.toISOString(),
          createdAt: grade.createdAt.toISOString(),
        };
      }),
    }));

    // Extract healthInfo from JSON
    const healthInfo = (student.healthInfo as any) || {};

    return {
      student: {
        id: student.id,
        uid: student.uid,
        firstName: student.firstName,
        middleName: student.middleName,
        lastName: student.lastName,
        dateOfBirth: student.dateOfBirth.toISOString(),
        email: student.user?.email || undefined,
        phone: student.user?.phone || undefined,
        bloodGroup: healthInfo.bloodGroup || undefined,
        allergies: healthInfo.allergies || undefined,
        medications: healthInfo.medications || undefined,
        emergencyContact: healthInfo.emergencyContact || undefined,
        emergencyContactPhone: healthInfo.emergencyContactPhone || undefined,
        medicalNotes: healthInfo.medicalNotes || undefined,
      },
      enrollment: {
        id: activeEnrollment.id,
        classLevel: activeEnrollment.classLevel,
        academicYear: activeEnrollment.academicYear,
        enrollmentDate: activeEnrollment.enrollmentDate.toISOString(),
        isActive: activeEnrollment.isActive,
      },
      // Include all enrollments grouped by class level
      enrollments,
      // Keep backward compatibility - include grades from active enrollment
      grades: activeEnrollment.grades.map((grade) => {
        const score = grade.score.toNumber();
        const maxScore = grade.maxScore.toNumber();
        const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
        return {
          id: grade.id,
          subject: grade.subject || 'N/A', // Ensure subject is never null
          gradeType: grade.gradeType,
          assessmentName: grade.assessmentName,
          sequence: grade.sequence,
          assessmentDate: grade.assessmentDate?.toISOString(),
          score,
          maxScore,
          grade: this.getLetterGrade(percentage),
          term: grade.term,
          academicYear: grade.academicYear,
          remarks: grade.remarks,
          signedAt: grade.signedAt?.toISOString(),
          createdAt: grade.createdAt.toISOString(),
        };
      }),
      fromSchool: {
        id: transfer.fromSchool.id,
        name: transfer.fromSchool.name,
      },
    };
  }

  /**
   * Complete transfer - migrate student data to destination school
   */
  async completeTransfer(schoolId: string, transferId: string, dto: CompleteTransferDto) {
    // Get transfer record
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        student: true,
        fromSchool: true,
        toSchool: true,
      },
    });

    if (!transfer) {
      throw new NotFoundException('Transfer not found');
    }

    if (transfer.toSchoolId !== schoolId) {
      throw new ForbiddenException('You can only complete transfers to your school');
    }

    if (transfer.status === TransferStatus.COMPLETED) {
      throw new ConflictException('Transfer has already been completed');
    }

    if (transfer.status === TransferStatus.REJECTED) {
      throw new BadRequestException('Cannot complete a rejected transfer');
    }

    // Get student data
    if (!transfer.tac || !transfer.studentId) {
      throw new BadRequestException('Transfer TAC or student ID is missing');
    }
    const studentData = await this.getStudentDataByTac(transfer.tac, transfer.studentId);

    // Find or create student in destination school
    const student = await this.prisma.student.findUnique({
      where: { id: transfer.studentId },
    });

    if (!student) {
      throw new NotFoundException('Student not found');
    }

    // Handle ClassArm enrollment (for PRIMARY/SECONDARY schools using ClassArms)
    let enrollmentClassLevel = dto.targetClassLevel;
    let enrollmentClassArmId: string | null = null;
    let enrollmentClassId: string | null = null;

    if (dto.classArmId) {
      // Validate ClassArm exists and belongs to destination school
      const classArm = await this.prisma.classArm.findUnique({
        where: { id: dto.classArmId },
        include: {
          classLevel: true,
        },
      });

      if (!classArm || classArm.classLevel.schoolId !== schoolId) {
        throw new BadRequestException(
          'ClassArm not found or does not belong to destination school'
        );
      }

      // Validate capacity if set
      if (classArm.capacity !== null) {
        const currentEnrollments = await this.prisma.enrollment.count({
          where: {
            classArmId: classArm.id,
            isActive: true,
            academicYear: dto.academicYear,
          },
        });

        if (currentEnrollments >= classArm.capacity) {
          throw new BadRequestException(
            `ClassArm "${classArm.name}" is at full capacity (${classArm.capacity} students)`
          );
        }
      }

      enrollmentClassArmId = classArm.id;
      enrollmentClassLevel = classArm.classLevel.name; // Auto-populate from ClassArm's ClassLevel
    } else {
      // Fallback to Class (for schools without ClassArms or TERTIARY - backward compatibility)
      const targetClass = await this.prisma.class.findFirst({
        where: {
          schoolId,
          OR: [{ name: dto.targetClassLevel }, { classLevel: dto.targetClassLevel }],
          isActive: true,
        },
      });

      if (targetClass) {
        enrollmentClassId = targetClass.id;
      }
      // If no matching class found, enrollment will be created with just classLevel (backward compatibility)
    }

    // Find active term to link enrollment to
    const activeTerm = await this.prisma.term.findFirst({
      where: {
        status: TermStatus.ACTIVE,
        academicSession: {
          schoolId: schoolId,
          status: SessionStatus.ACTIVE,
        },
      },
      orderBy: {
        number: 'desc',
      },
    });

    const defaultTeacher = await this.prisma.teacher.findFirst({
      where: { schoolId },
      select: { id: true },
    });

    if (!defaultTeacher) {
      throw new BadRequestException(
        'No teacher found in destination school. Cannot transfer grades.'
      );
    }

    const newEnrollment = await this.prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.create({
        data: {
          studentId: student.id,
          schoolId,
          classArmId: enrollmentClassArmId,
          classId: enrollmentClassId || dto.classId || null,
          classLevel: enrollmentClassLevel,
          academicYear: dto.academicYear,
          enrollmentDate: new Date(),
          isActive: true,
          termId: activeTerm?.id || null,
        },
      });

      for (const grade of studentData.grades) {
        await tx.grade.create({
          data: {
            enrollmentId: enrollment.id,
            teacherId: defaultTeacher.id,
            subject: grade.subject,
            gradeType: grade.gradeType || 'CA',
            assessmentName: grade.assessmentName,
            sequence: grade.sequence,
            assessmentDate: grade.assessmentDate ? new Date(grade.assessmentDate) : null,
            score: grade.score,
            maxScore: grade.maxScore,
            term: grade.term,
            academicYear: grade.academicYear,
            remarks: grade.remarks,
            signedAt: grade.signedAt ? new Date(grade.signedAt) : undefined,
            createdAt: new Date(grade.createdAt),
          },
        });
      }

      const hasHealthInfo =
        studentData.student.bloodGroup ||
        studentData.student.allergies ||
        studentData.student.medications ||
        studentData.student.emergencyContact ||
        studentData.student.emergencyContactPhone ||
        studentData.student.medicalNotes;

      if (hasHealthInfo) {
        const currentHealthInfo = (student.healthInfo as any) || {};
        const updatedHealthInfo = {
          ...currentHealthInfo,
          ...(studentData.student.bloodGroup && { bloodGroup: studentData.student.bloodGroup }),
          ...(studentData.student.allergies && { allergies: studentData.student.allergies }),
          ...(studentData.student.medications && { medications: studentData.student.medications }),
          ...(studentData.student.emergencyContact && { emergencyContact: studentData.student.emergencyContact }),
          ...(studentData.student.emergencyContactPhone && { emergencyContactPhone: studentData.student.emergencyContactPhone }),
          ...(studentData.student.medicalNotes && { medicalNotes: studentData.student.medicalNotes }),
        };
        await tx.student.update({
          where: { id: student.id },
          data: { healthInfo: updatedHealthInfo },
        });
      }

      await tx.enrollment.update({
        where: { id: studentData.enrollment.id },
        data: { isActive: false },
      });

      const completed = await tx.enrollment.findUnique({
        where: { id: enrollment.id },
        select: { id: true, isActive: true },
      });
      if (!completed?.isActive) {
        throw new BadRequestException('Transfer could not create an active enrollment.');
      }

      await tx.transfer.update({
        where: { id: transferId },
        data: {
          status: TransferStatus.COMPLETED,
          completedAt: new Date(),
          tacUsedAt: new Date(),
          tacUsedBy: schoolId,
        },
      });

      return enrollment;
    });

    return {
      transferId,
      newEnrollmentId: newEnrollment.id,
      message: 'Transfer completed successfully',
    };
  }

  /**
   * Reject transfer
   */
  async rejectTransfer(schoolId: string, transferId: string, dto: RejectTransferDto) {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
    });

    if (!transfer) {
      throw new NotFoundException('Transfer not found');
    }

    if (transfer.toSchoolId !== schoolId) {
      throw new ForbiddenException('You can only reject transfers to your school');
    }

    if (transfer.status === TransferStatus.COMPLETED) {
      throw new ConflictException('Cannot reject a completed transfer');
    }

    if (transfer.kind === 'SCHOOL_CLOSURE') {
      await this.prisma.transfer.update({
        where: { id: transferId },
        data: {
          status: TransferStatus.PENDING,
          toSchoolId: null,
          approvedAt: null,
          rejectedAt: null,
          rejectionReason: null,
        },
      });
      return {
        message: 'Incoming transfer released. The student can use this code at another school.',
      };
    }

    await this.prisma.transfer.update({
      where: { id: transferId },
      data: {
        status: TransferStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason: dto.reason,
      },
    });

    return {
      message: 'Transfer rejected successfully',
    };
  }

  /**
   * Get historical grades for a completed transfer
   * This allows the source school to view grades from when the student was enrolled
   */
  async getTransferHistoricalGrades(schoolId: string, transferId: string) {
    // Get transfer record
    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        student: true,
        fromSchool: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException('Transfer not found');
    }

    // Verify this is an outgoing transfer from this school
    if (transfer.fromSchoolId !== schoolId) {
      throw new ForbiddenException(
        'You can only view historical grades for transfers from your school'
      );
    }

    // Only allow viewing grades for completed transfers
    if (transfer.status !== TransferStatus.COMPLETED) {
      throw new BadRequestException('Historical grades are only available for completed transfers');
    }

    // Get all enrollments the student had in this school (including inactive ones)
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId: transfer.studentId,
        schoolId: schoolId,
      },
      include: {
        grades: {
          orderBy: [{ academicYear: 'desc' }, { term: 'desc' }, { createdAt: 'desc' }],
        },
      },
      orderBy: {
        enrollmentDate: 'desc',
      },
    });

    // Map enrollments with grades
    const enrollmentsData = enrollments.map((enrollment) => ({
      id: enrollment.id,
      classLevel: enrollment.classLevel,
      academicYear: enrollment.academicYear,
      enrollmentDate: enrollment.enrollmentDate.toISOString(),
      isActive: enrollment.isActive,
      grades: enrollment.grades.map((grade) => {
        const score = grade.score.toNumber();
        const maxScore = grade.maxScore.toNumber();
        const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;
        return {
          id: grade.id,
          subject: grade.subject || 'N/A',
          gradeType: grade.gradeType,
          assessmentName: grade.assessmentName,
          sequence: grade.sequence,
          assessmentDate: grade.assessmentDate?.toISOString(),
          score,
          maxScore,
          grade: this.getLetterGrade(percentage),
          term: grade.term,
          academicYear: grade.academicYear,
          remarks: grade.remarks,
          signedAt: grade.signedAt?.toISOString(),
          createdAt: grade.createdAt.toISOString(),
        };
      }),
    }));

    return {
      student: {
        id: transfer.student.id,
        uid: transfer.student.uid,
        firstName: transfer.student.firstName,
        middleName: transfer.student.middleName,
        lastName: transfer.student.lastName,
      },
      enrollments: enrollmentsData,
      fromSchool: {
        id: transfer.fromSchool.id,
        name: transfer.fromSchool.name,
      },
      transfer: {
        id: transfer.id,
        status: transfer.status,
        completedAt: transfer.completedAt?.toISOString(),
      },
    };
  }

  /**
   * List outgoing transfers
   */
  async getOutgoingTransfers(
    schoolId: string,
    status?: TransferStatus,
    page = 1,
    limit = 20,
    schoolType?: string
  ) {
    const skip = (page - 1) * limit;

    // If schoolType is provided, get classes of that type to filter enrollments
    let classIds: string[] | undefined;
    let classLevels: string[] | undefined;
    if (schoolType) {
      const classes = await this.prisma.class.findMany({
        where: {
          schoolId,
          type: schoolType as any,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
        },
      });
      classIds = classes.map((c) => c.id);
      classLevels = classes.map((c) => c.name);
    }

    const where: any = {
      fromSchoolId: schoolId,
    };

    if (status) {
      where.status = status;
    }

    const [transfers, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          student: {
            select: {
              id: true,
              uid: true,
              firstName: true,
              lastName: true,
              enrollments: {
                where: {
                  schoolId,
                  isActive: true,
                  ...(schoolType &&
                  classIds &&
                  classLevels &&
                  (classIds.length > 0 || classLevels.length > 0)
                    ? {
                        OR: [
                          ...(classIds.length > 0 ? [{ classId: { in: classIds } }] : []),
                          ...(classLevels.length > 0 ? [{ classLevel: { in: classLevels } }] : []),
                        ],
                      }
                    : {}),
                },
              },
            },
          },
          toSchool: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.transfer.count({ where }),
    ]);

    // Filter transfers by schoolType if provided (only include transfers where student has enrollment in that schoolType)
    let filteredTransfers = transfers;
    if (schoolType && (classIds || classLevels)) {
      filteredTransfers = transfers.filter((transfer) => {
        return transfer.student.enrollments && transfer.student.enrollments.length > 0;
      });
    }

    return {
      transfers,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * List incoming transfers
   */
  async getIncomingTransfers(
    schoolId: string,
    status?: TransferStatus,
    page = 1,
    limit = 20,
    schoolType?: string
  ) {
    const skip = (page - 1) * limit;

    // If schoolType is provided, get classes of that type to filter enrollments
    let classIds: string[] | undefined;
    let classLevels: string[] | undefined;
    if (schoolType) {
      const classes = await this.prisma.class.findMany({
        where: {
          schoolId,
          type: schoolType as any,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
        },
      });
      classIds = classes.map((c) => c.id);
      classLevels = classes.map((c) => c.name);
    }

    const where: any = {
      toSchoolId: schoolId,
    };

    if (status) {
      where.status = status;
    }

    const [transfers, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where,
        skip,
        take: limit * 2, // Get more to account for filtering
        orderBy: { createdAt: 'desc' },
        include: {
          student: {
            select: {
              id: true,
              uid: true,
              firstName: true,
              lastName: true,
              enrollments: {
                where: {
                  schoolId,
                  isActive: true,
                  ...(schoolType &&
                  classIds &&
                  classLevels &&
                  (classIds.length > 0 || classLevels.length > 0)
                    ? {
                        OR: [
                          ...(classIds.length > 0 ? [{ classId: { in: classIds } }] : []),
                          ...(classLevels.length > 0 ? [{ classLevel: { in: classLevels } }] : []),
                        ],
                      }
                    : {}),
                },
              },
            },
          },
          fromSchool: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.transfer.count({ where }),
    ]);

    // Filter transfers by schoolType if provided (only include transfers where student has enrollment in that schoolType)
    let filteredTransfers = transfers;
    if (schoolType && (classIds || classLevels)) {
      filteredTransfers = transfers.filter((transfer) => {
        return transfer.student.enrollments && transfer.student.enrollments.length > 0;
      });
    }

    // Apply pagination to filtered results
    const paginatedTransfers = filteredTransfers.slice(skip, skip + limit);

    return {
      transfers: paginatedTransfers,
      meta: {
        total: filteredTransfers.length,
        page,
        limit,
        totalPages: Math.ceil(filteredTransfers.length / limit),
        hasNextPage: page * limit < filteredTransfers.length,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * List recently accepted (completed) transfers to this school.
   * Used for the "Recently accepted students" section with full details:
   * target class, source school/class, and performance from previous school.
   */
  async getRecentlyAcceptedTransfers(schoolId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [transfers, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where: {
          toSchoolId: schoolId,
          status: TransferStatus.COMPLETED,
          completedAt: { not: null },
        },
        orderBy: { completedAt: 'desc' },
        skip,
        take: limit,
        include: {
          student: {
            select: {
              id: true,
              uid: true,
              firstName: true,
              middleName: true,
              lastName: true,
              dateOfBirth: true,
              profileImage: true,
              user: {
                select: {
                  email: true,
                  phone: true,
                },
              },
            },
          },
          fromSchool: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.transfer.count({
        where: {
          toSchoolId: schoolId,
          status: TransferStatus.COMPLETED,
          completedAt: { not: null },
        },
      }),
    ]);

    if (transfers.length === 0) {
      return {
        items: [],
        meta: {
          total: 0,
          page,
          limit,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      };
    }

    const studentIds = [...new Set(transfers.map((t) => t.studentId))];
    const fromSchoolIds = [...new Set(transfers.map((t) => t.fromSchoolId))];

    // Target enrollments (current school, active) with grades
    const targetEnrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId: { in: studentIds },
        schoolId,
        isActive: true,
      },
      include: {
        grades: {
          select: {
            score: true,
            maxScore: true,
          },
        },
        classArm: {
          select: { name: true },
        },
      },
    });
    const targetByStudent = new Map<string, (typeof targetEnrollments)[0]>(
      targetEnrollments.map((e) => [e.studentId, e])
    );

    // Source enrollments (from school, inactive) - most recently updated is the one we deactivated
    const sourceEnrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId: { in: studentIds },
        schoolId: { in: fromSchoolIds },
        isActive: false,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const sourceByStudentAndSchool = new Map<string, (typeof sourceEnrollments)[0]>();
    for (const e of sourceEnrollments) {
      const key = `${e.studentId}:${e.schoolId}`;
      if (!sourceByStudentAndSchool.has(key)) {
        sourceByStudentAndSchool.set(key, e);
      }
    }

    const items = transfers.map((transfer) => {
      const target = targetByStudent.get(transfer.studentId);
      const source = sourceByStudentAndSchool.get(
        `${transfer.studentId}:${transfer.fromSchoolId}`
      );

      let gradeCount = 0;
      let totalScore = 0;
      let totalMax = 0;
      if (target?.grades?.length) {
        gradeCount = target.grades.length;
        for (const g of target.grades) {
          totalScore += g.score.toNumber();
          totalMax += g.maxScore.toNumber();
        }
      }
      const averagePercentage =
        totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : null;

      return {
        id: transfer.id,
        completedAt: transfer.completedAt,
        student: {
          id: transfer.student.id,
          uid: transfer.student.uid,
          firstName: transfer.student.firstName,
          middleName: transfer.student.middleName,
          lastName: transfer.student.lastName,
          dateOfBirth: transfer.student.dateOfBirth,
          profileImage: transfer.student.profileImage,
          email: transfer.student.user?.email,
          phone: transfer.student.user?.phone,
        },
        fromSchool: transfer.fromSchool,
        targetEnrollment: target
          ? {
              id: target.id,
              classLevel: target.classLevel,
              academicYear: target.academicYear,
              classArmName: target.classArm?.name ?? null,
            }
          : null,
        sourceEnrollment: source
          ? {
              classLevel: source.classLevel,
              academicYear: source.academicYear,
            }
          : null,
        performanceSummary: {
          gradeCount,
          averagePercentage,
        },
      };
    });

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Revoke TAC (if not used)
   */
  async revokeTac(schoolId: string, transferId: string) {
    // Get school info for email
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });

    const transfer = await this.prisma.transfer.findUnique({
      where: { id: transferId },
      include: {
        student: {
          include: {
            user: {
              select: {
                email: true,
              },
            },
          },
        },
      },
    });

    if (!transfer) {
      throw new NotFoundException('Transfer not found');
    }

    if (transfer.fromSchoolId !== schoolId) {
      throw new ForbiddenException('You can only revoke TACs from your school');
    }

    if (transfer.tacUsedAt) {
      throw new ConflictException('Cannot revoke a TAC that has already been used');
    }

    await this.prisma.transfer.update({
      where: { id: transferId },
      data: {
        tac: null,
        tacGeneratedAt: null,
        tacExpiresAt: null,
        status: TransferStatus.CANCELLED,
      },
    });

    // Send email to student if email exists
    const studentEmail = transfer.student?.user?.email;
    if (studentEmail && school) {
      try {
        await this.emailService.sendTransferRevocationEmail(
          studentEmail,
          `${transfer.student.firstName} ${transfer.student.lastName}`,
          school.name
        );
      } catch (error) {
        // Log error but don't fail the request
        this.logger.error(
          'Failed to send transfer revocation email:',
          error instanceof Error ? error.stack : error
        );
      }
    } else if (!studentEmail) {
      console.warn(
        `Student ${transfer.studentId} does not have an email address. Cannot send revocation notification.`
      );
    }

    return {
      message: 'TAC revoked successfully',
    };
  }
}
