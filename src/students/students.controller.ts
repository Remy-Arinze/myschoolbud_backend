import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { SchoolDataAccessGuard } from '../common/guards/school-data-access.guard';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/permission.decorator';
import { PermissionResource, PermissionType } from '../schools/dto/permission.dto';
import { TenantId } from '../common/decorators/tenant.decorator';
import { StudentsService } from './students.service';
import { StudentAdmissionService } from './student-admission.service';
import { StudentDto, StudentWithEnrollmentDto } from './dto/student.dto';
import { AddStudentDto } from '../schools/dto/add-student.dto';
import { SubmitAdmissionApplicationDto, ApproveAdmissionApplicationDto, RejectAdmissionApplicationDto } from './dto/admission-application.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { PaginationDto, PaginatedResponseDto } from '../common/dto/pagination.dto';
import { GetStudentsDto } from './dto/get-students.dto';
import { ResponseDto } from '../common/dto/response.dto';
import { OnboardingService } from '../onboarding/onboarding.service';
import { ImportSummaryDto } from '../onboarding/dto/bulk-import.dto';
import { ApiConsumes } from '@nestjs/swagger';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import { ReassignStudentDto } from './dto/reassign-student.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserWithContext } from '../auth/types/user-with-context.type';
import { Throttle } from '@nestjs/throttler';
import { AdmissionStatus } from '@prisma/client';

/**
 * standard tier: Student data listing and entity fetches.
 */
@ApiTags('students')
@Controller('students')
@UseGuards(JwtAuthGuard, TenantGuard)
@ApiBearerAuth('JWT-auth')
@Throttle({ standard: {} })
export class StudentsController {
  constructor(
    private readonly studentsService: StudentsService,
    private readonly studentAdmissionService: StudentAdmissionService
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get paginated list of students' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'List of students',
    type: ResponseDto<PaginatedResponseDto<StudentDto>>,
  })
  async findAll(
    @TenantId() tenantId: string,
    @Query() pagination: PaginationDto
  ): Promise<ResponseDto<PaginatedResponseDto<StudentDto>>> {
    const data = await this.studentsService.findAll(tenantId, pagination);
    return ResponseDto.ok(data, 'Students retrieved successfully');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get student by ID' })
  @ApiParam({ name: 'id', description: 'Student ID', example: 'clx1234567890' })
  @ApiResponse({
    status: 200,
    description: 'Student details',
    type: ResponseDto<StudentWithEnrollmentDto>,
  })
  @ApiResponse({ status: 404, description: 'Student not found' })
  async findOne(
    @TenantId() tenantId: string,
    @Param('id') id: string
  ): Promise<ResponseDto<StudentWithEnrollmentDto>> {
    const data = await this.studentsService.findOne(tenantId, id);
    return ResponseDto.ok(data, 'Student retrieved successfully');
  }

  @Get('uid/:uid')
  @ApiOperation({ summary: 'Get student by Universal ID (UID)' })
  @ApiParam({
    name: 'uid',
    description: 'Universal ID',
    example: 'AGO-2025-001',
  })
  @ApiResponse({
    status: 200,
    description: 'Student details',
    type: ResponseDto<StudentWithEnrollmentDto>,
  })
  @ApiResponse({ status: 404, description: 'Student not found' })
  async findByUid(
    @TenantId() tenantId: string,
    @Param('uid') uid: string
  ): Promise<ResponseDto<StudentWithEnrollmentDto>> {
    const data = await this.studentsService.findByUid(tenantId, uid);
    return ResponseDto.ok(data, 'Student retrieved successfully');
  }
}

@ApiTags('schools')
@Controller('schools/:schoolId/students')
@UseGuards(JwtAuthGuard, SchoolDataAccessGuard, PermissionGuard)
@ApiBearerAuth('JWT-auth')
export class SchoolStudentAdmissionController {
  constructor(
    private readonly studentAdmissionService: StudentAdmissionService,
    private readonly studentsService: StudentsService,
    private readonly onboardingService: OnboardingService,
    private readonly authService: AuthService,
    private readonly prisma: PrismaService
  ) {}

  @Get()
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.READ)
  @ApiOperation({ summary: 'Get paginated list of students for a school' })
  @ApiResponse({
    status: 200,
    description: 'List of students',
    type: ResponseDto<PaginatedResponseDto<StudentWithEnrollmentDto>>,
  })
  async getStudents(
    @Param('schoolId') schoolId: string,
    @Query() query: GetStudentsDto
  ): Promise<ResponseDto<PaginatedResponseDto<StudentWithEnrollmentDto>>> {
    const { schoolType, search, status, ...pagination } = query;
    const data = await this.studentsService.findAll(
      schoolId,
      pagination,
      schoolType,
      search,
      status,
    );
    return ResponseDto.ok(data, 'Students retrieved successfully');
  }

  @Get('by-class/:classLevel')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.READ)
  @ApiOperation({ summary: 'Get students enrolled in a specific class' })
  @ApiParam({ name: 'classLevel', description: 'Class level/name', example: 'JSS1' })
  @ApiResponse({
    status: 200,
    description: 'Students retrieved successfully',
    type: ResponseDto<StudentWithEnrollmentDto[]>,
  })
  async getStudentsByClass(
    @Param('schoolId') schoolId: string,
    @Param('classLevel') classLevel: string
  ): Promise<ResponseDto<StudentWithEnrollmentDto[]>> {
    const data = await this.studentsService.findByClassLevel(schoolId, classLevel);
    return ResponseDto.ok(data, 'Students retrieved successfully');
  }

  @Get(':id')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.READ)
  @ApiOperation({ summary: 'Get student by ID for a school' })
  @ApiParam({ name: 'schoolId', description: 'School ID' })
  @ApiParam({ name: 'id', description: 'Student ID', example: 'clx1234567890' })
  @ApiResponse({
    status: 200,
    description: 'Student details',
    type: ResponseDto<StudentWithEnrollmentDto>,
  })
  @ApiResponse({ status: 404, description: 'Student not found' })
  async getStudentById(
    @Param('schoolId') schoolId: string,
    @Param('id') id: string
  ): Promise<ResponseDto<StudentWithEnrollmentDto>> {
    const data = await this.studentsService.findOne(schoolId, id);
    return ResponseDto.ok(data, 'Student retrieved successfully');
  }

  @Post('admit')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @ApiOperation({ summary: 'Add a new student to the school' })
  @ApiResponse({
    status: 201,
    description: 'Student admitted successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 409, description: 'Student email already exists - transfer required' })
  async admitStudent(
    @Param('schoolId') schoolId: string,
    @Body() addStudentDto: AddStudentDto
  ): Promise<ResponseDto<any>> {
    const data = await this.studentAdmissionService.addStudent(schoolId, addStudentDto);
    return ResponseDto.ok(data, data.message || 'Student admitted successfully');
  }

  @Get('admissions/applications')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.READ)
  @ApiOperation({ summary: 'Get admission applications for the school' })
  async getApplications(
    @Param('schoolId') schoolId: string,
    @Query('status') status?: AdmissionStatus
  ): Promise<ResponseDto<any[]>> {
    const data = await this.studentAdmissionService.getApplications(schoolId, status);
    return ResponseDto.ok(data, 'Applications retrieved successfully');
  }

  @Post('admissions/applications/:applicationId/approve')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @ApiOperation({ summary: 'Approve an admission application' })
  async approveApplication(
    @Param('schoolId') schoolId: string,
    @Param('applicationId') applicationId: string,
    @Body() approveDto: ApproveAdmissionApplicationDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const data = await this.studentAdmissionService.approveApplication(schoolId, applicationId, approveDto, user.id);
    return ResponseDto.ok(data, 'Application approved successfully');
  }

  @Post('admissions/applications/:applicationId/reject')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @ApiOperation({ summary: 'Reject an admission application' })
  async rejectApplication(
    @Param('schoolId') schoolId: string,
    @Param('applicationId') applicationId: string,
    @Body() rejectDto: RejectAdmissionApplicationDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const data = await this.studentAdmissionService.rejectApplication(schoolId, applicationId, rejectDto.reason, user.id);
    return ResponseDto.ok(data, 'Application rejected successfully');
  }

  @Post('bulk-import')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max for bulk import files
      },
    })
  )
  @ApiOperation({
    summary: 'Bulk import students from CSV/Excel file',
    description:
      'Upload a CSV or Excel file to import multiple students at once. Uses the same validation and flow as individual student admission. Maximum file size: 10MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 200,
    description: 'Bulk import completed',
    type: ResponseDto<ImportSummaryDto>,
  })
  @ApiResponse({ status: 400, description: 'Invalid file format or missing required fields' })
  async bulkImportStudents(
    @Param('schoolId') schoolId: string,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ResponseDto<ImportSummaryDto>> {
    const data = await this.onboardingService.bulkImport(file, schoolId);
    return ResponseDto.ok(data, 'Bulk import completed');
  }

  @Post(':id/image')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    })
  )
  @ApiOperation({ summary: 'Upload student profile image' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 200,
    description: 'Image uploaded successfully',
  })
  @ApiResponse({ status: 404, description: 'Student not found' })
  async uploadStudentImage(
    @Param('schoolId') schoolId: string,
    @Param('id') studentId: string,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ResponseDto<any>> {
    // Verify student exists in this school
    const student = await this.studentsService.findOne(schoolId, studentId);

    // Get the student from database to access userId for upload
    const studentWithUser = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });

    if (!studentWithUser || !studentWithUser.userId) {
      throw new NotFoundException('Student not found or does not have a user account');
    }

    // Create a mock UserWithContext for the upload method
    const mockUser: any = {
      id: studentWithUser.userId,
      role: 'STUDENT',
      currentSchoolId: schoolId,
    };

    const data = await this.studentsService.uploadProfileImage(mockUser, file);
    return ResponseDto.ok(data, 'Image uploaded successfully');
  }

  @Post(':id/resend-password-reset')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @ApiOperation({ summary: 'Resend password reset email for a student' })
  @ApiResponse({
    status: 200,
    description: 'Password reset email resent successfully',
  })
  @ApiResponse({ status: 404, description: 'Student not found' })
  @ApiResponse({ status: 400, description: 'Student does not have an email address' })
  async resendPasswordResetForStudent(
    @Param('schoolId') schoolId: string,
    @Param('id') studentId: string
  ): Promise<ResponseDto<void>> {
    // Verify student exists in this school
    await this.studentsService.findOne(schoolId, studentId);

    // Get the student from database to access userId
    const studentWithUser = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });

    if (!studentWithUser || !studentWithUser.userId) {
      throw new NotFoundException('Student not found or does not have a user account');
    }

    await this.authService.resendPasswordResetEmail(studentWithUser.userId, schoolId);
    return ResponseDto.ok(undefined, 'Password reset email resent successfully');
  }

  @Patch(':id')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @ApiOperation({ summary: 'Update student profile' })
  @ApiResponse({
    status: 200,
    description: 'Student profile updated successfully',
    type: ResponseDto<StudentWithEnrollmentDto>,
  })
  @ApiResponse({ status: 404, description: 'Student not found' })
  async updateStudent(
    @Param('schoolId') schoolId: string,
    @Param('id') studentId: string,
    @Body() updateDto: UpdateStudentDto
  ): Promise<ResponseDto<StudentWithEnrollmentDto>> {
    const data = await this.studentsService.updateStudent(schoolId, studentId, updateDto);
    return ResponseDto.ok(data, 'Student profile updated successfully');
  }

  @Post(':id/reassign')
  @RequirePermission(PermissionResource.STUDENTS, PermissionType.WRITE)
  @ApiOperation({ summary: 'Reassign student to a different class' })
  @ApiParam({ name: 'schoolId', description: 'School ID' })
  @ApiParam({ name: 'id', description: 'Student ID' })
  @ApiResponse({
    status: 200,
    description: 'Student reassigned successfully',
  })
  async reassignStudent(
    @Param('schoolId') schoolId: string,
    @Param('id') studentId: string,
    @Body() reassignDto: ReassignStudentDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const data = await this.studentsService.reassignStudent(
      schoolId,
      studentId,
      reassignDto,
      user.currentProfileId,
      `${user.firstName || 'Staff'} ${user.lastName || ''}`.trim()
    );
    return ResponseDto.ok(data, data.message);
  }
}

