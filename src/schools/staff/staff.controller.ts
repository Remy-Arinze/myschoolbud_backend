import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
  UseInterceptors,
  UploadedFile,
  Post as PostDecorator,
  Req,
  Ip,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserWithContext } from '../../auth/types/user-with-context.type';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiConsumes,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AdminService } from './admins/admin.service';
import { TeacherService } from './teachers/teacher.service';
import { TeacherSubjectsService } from './teachers/teacher-subjects.service';
import { AddAdminDto } from '../dto/add-admin.dto';
import { AddTeacherDto } from '../dto/add-teacher.dto';
import { UpdateAdminDto } from '../dto/update-admin.dto';
import { UpdateTeacherDto } from '../dto/update-teacher.dto';
import { UpdatePrincipalDto } from '../dto/update-principal.dto';
import { ChangeAccessTierDto, MakePrincipalDto } from '../dto/change-access-tier.dto';
import {
  CreateSchoolRoleTemplateDto,
  ReapplyRoleTemplateDto,
  RoleTemplateDto,
  UpdateSchoolRoleTemplateDto,
} from '../dto/role-template.dto';
import { RoleTemplateService } from './permissions/role-template.service';
import { ConvertTeacherToAdminDto } from '../dto/convert-teacher-to-admin.dto';
import { AssignPermissionsDto, PermissionResource, PermissionType } from '../dto/permission.dto';
import {
  UpdateTeacherSubjectsDto,
  AddTeacherSubjectDto,
  TeacherSubjectDto,
  TeacherWithSubjectsDto,
  AssignableSubjectDto,
} from '../dto/teacher-subjects.dto';
import { ResponseDto } from '../../common/dto/response.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { SchoolDataAccessGuard } from '../../common/guards/school-data-access.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/permission.decorator';
import { PermissionService } from './permissions/permission.service';
import { StaffImportService } from './staff-import.service';
import { AuthService } from '../../auth/auth.service';
import { StaffImportSummaryDto } from '../dto/staff-bulk-import.dto';

@ApiTags('schools')
@Controller('schools/:schoolId')
@UseGuards(JwtAuthGuard, SchoolDataAccessGuard, PermissionGuard)
@ApiBearerAuth()
export class StaffController {
  constructor(
    private readonly adminService: AdminService,
    private readonly teacherService: TeacherService,
    private readonly teacherSubjectsService: TeacherSubjectsService,
    private readonly permissionService: PermissionService,
    private readonly roleTemplateService: RoleTemplateService,
    private readonly staffImportService: StaffImportService,
    private readonly authService: AuthService
  ) { }

  // Admin endpoints
  @Post('admins')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({ summary: 'Add an administrator to a school' })
  @ApiResponse({
    status: 201,
    description: 'Administrator added successfully',
  })
  @ApiResponse({ status: 404, description: 'School not found' })
  @ApiResponse({ status: 409, description: 'User with email or phone already exists' })
  async addAdmin(
    @Param('schoolId') schoolId: string,
    @Body() addAdminDto: AddAdminDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const result = await this.adminService.addAdmin(schoolId, addAdminDto, user);
    const warnings = result.emailFailed
      ? ['Password setup email could not be sent. You can resend it from the staff list.']
      : undefined;
    return ResponseDto.ok(result.data, 'Administrator added successfully', warnings);
  }

  @PostDecorator('admins/:adminId/image')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    })
  )
  @ApiOperation({ summary: 'Upload admin profile image' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 200,
    description: 'Image uploaded successfully',
  })
  @ApiResponse({ status: 404, description: 'School or admin not found' })
  async uploadAdminImage(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ResponseDto<any>> {
    const data = await this.adminService.uploadProfileImage(schoolId, adminId, file);
    return ResponseDto.ok(data, 'Image uploaded successfully');
  }

  @Patch('admins/:adminId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({ summary: 'Update an administrator in a school' })
  @ApiResponse({
    status: 200,
    description: 'Administrator updated successfully',
  })
  @ApiResponse({ status: 404, description: 'School or administrator not found' })
  async updateAdmin(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string,
    @Body() updateAdminDto: UpdateAdminDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const data = await this.adminService.updateAdmin(schoolId, adminId, updateAdminDto, user);
    return ResponseDto.ok(data, 'Administrator updated successfully');
  }

  @Delete('admins/:adminId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Delete an administrator from a school' })
  @ApiResponse({
    status: 200,
    description: 'Administrator deleted successfully',
  })
  @ApiResponse({ status: 404, description: 'School or administrator not found' })
  @ApiResponse({ status: 403, description: 'Insufficient role to delete this administrator' })
  async deleteAdmin(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<void>> {
    await this.adminService.deleteAdmin(schoolId, adminId, user);
    return ResponseDto.ok(undefined, 'Administrator deleted successfully');
  }

  // Teacher endpoints
  @Post('teachers')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({ summary: 'Add a teacher to a school' })
  @ApiResponse({
    status: 201,
    description: 'Teacher added successfully',
  })
  @ApiResponse({ status: 404, description: 'School not found' })
  @ApiResponse({ status: 409, description: 'User with email or phone already exists' })
  async addTeacher(
    @Param('schoolId') schoolId: string,
    @Body() addTeacherDto: AddTeacherDto
  ): Promise<ResponseDto<any>> {
    const result = await this.teacherService.addTeacher(schoolId, addTeacherDto);
    const warnings = result.emailFailed
      ? ['Password setup email could not be sent. You can resend it from the staff list.']
      : undefined;
    return ResponseDto.ok(result.data, 'Teacher added successfully', warnings);
  }

  @PostDecorator('teachers/:teacherId/image')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    })
  )
  @ApiOperation({ summary: 'Upload teacher profile image' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 200,
    description: 'Image uploaded successfully',
  })
  @ApiResponse({ status: 404, description: 'School or teacher not found' })
  async uploadTeacherImage(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ResponseDto<any>> {
    const data = await this.teacherService.uploadProfileImage(schoolId, teacherId, file);
    return ResponseDto.ok(data, 'Image uploaded successfully');
  }

  @Patch('teachers/:teacherId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({ summary: 'Update a teacher in a school' })
  @ApiResponse({
    status: 200,
    description: 'Teacher updated successfully',
  })
  @ApiResponse({ status: 404, description: 'School or teacher not found' })
  async updateTeacher(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @Body() updateTeacherDto: UpdateTeacherDto
  ): Promise<ResponseDto<any>> {
    const data = await this.teacherService.updateTeacher(schoolId, teacherId, updateTeacherDto);
    return ResponseDto.ok(data, 'Teacher updated successfully');
  }

  @Delete('teachers/:teacherId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Delete a teacher from a school' })
  @ApiResponse({
    status: 200,
    description: 'Teacher deleted successfully',
  })
  @ApiResponse({ status: 404, description: 'School or teacher not found' })
  @ApiResponse({ status: 403, description: 'Insufficient role to delete this teacher' })
  async deleteTeacher(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<void>> {
    await this.teacherService.deleteTeacher(schoolId, teacherId, user);
    return ResponseDto.ok(undefined, 'Teacher deleted successfully');
  }

  // =====================
  // Teacher Subject Competencies
  // =====================

  @Get('teachers/:teacherId/subjects')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({
    summary: 'Get subjects a teacher is qualified to teach',
    description: 'Returns all subjects the teacher can teach along with assignment counts',
  })
  @ApiResponse({
    status: 200,
    description: 'Teacher subjects retrieved successfully',
    type: [TeacherSubjectDto],
  })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  async getTeacherSubjects(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string
  ): Promise<ResponseDto<TeacherSubjectDto[]>> {
    const data = await this.teacherSubjectsService.getTeacherSubjects(schoolId, teacherId);
    return ResponseDto.ok(data, 'Teacher subjects retrieved successfully');
  }

  @Get('teachers/:teacherId/subjects/details')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({
    summary: 'Get teacher with all subject competencies and assignment totals',
    description: 'Returns teacher info with subjects and total class assignments',
  })
  @ApiResponse({
    status: 200,
    description: 'Teacher with subjects retrieved successfully',
    type: TeacherWithSubjectsDto,
  })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  async getTeacherWithSubjects(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string
  ): Promise<ResponseDto<TeacherWithSubjectsDto>> {
    const data = await this.teacherSubjectsService.getTeacherWithSubjects(schoolId, teacherId);
    return ResponseDto.ok(data, 'Teacher with subjects retrieved successfully');
  }

  @Put('teachers/:teacherId/subjects')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({
    summary: 'Update all subjects a teacher can teach',
    description: 'Replaces all existing subject competencies with the provided list',
  })
  @ApiResponse({
    status: 200,
    description: 'Teacher subjects updated successfully',
    type: [TeacherSubjectDto],
  })
  @ApiResponse({ status: 404, description: 'Teacher or subject not found' })
  @ApiResponse({ status: 400, description: 'Invalid subject IDs' })
  async updateTeacherSubjects(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @Body() dto: UpdateTeacherSubjectsDto
  ): Promise<ResponseDto<TeacherSubjectDto[]>> {
    const data = await this.teacherSubjectsService.updateTeacherSubjects(schoolId, teacherId, dto);
    return ResponseDto.ok(data, 'Teacher subjects updated successfully');
  }

  @Post('teachers/:teacherId/subjects')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({
    summary: 'Add a subject to teacher competencies',
    description: 'Adds a single subject the teacher can teach',
  })
  @ApiResponse({
    status: 201,
    description: 'Subject added to teacher successfully',
    type: TeacherSubjectDto,
  })
  @ApiResponse({ status: 404, description: 'Teacher or subject not found' })
  @ApiResponse({ status: 409, description: 'Teacher already has this subject' })
  async addTeacherSubject(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @Body() dto: AddTeacherSubjectDto
  ): Promise<ResponseDto<TeacherSubjectDto>> {
    const data = await this.teacherSubjectsService.addTeacherSubject(
      schoolId,
      teacherId,
      dto.subjectId
    );
    return ResponseDto.ok(data, 'Subject added to teacher successfully');
  }

  @Delete('teachers/:teacherId/subjects/:subjectId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({
    summary: 'Remove a subject from teacher competencies',
    description:
      'Removes a subject from teacher. Will fail if teacher is currently teaching this subject in any class.',
  })
  @ApiResponse({
    status: 200,
    description: 'Subject removed from teacher successfully',
  })
  @ApiResponse({ status: 404, description: 'Teacher or subject not found' })
  @ApiResponse({
    status: 409,
    description: 'Cannot remove subject - teacher is currently teaching it',
  })
  async removeTeacherSubject(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @Param('subjectId') subjectId: string
  ): Promise<ResponseDto<void>> {
    await this.teacherSubjectsService.removeTeacherSubject(schoolId, teacherId, subjectId);
    return ResponseDto.ok(undefined, 'Subject removed from teacher successfully');
  }

  @Get('teachers/:teacherId/assignable-subjects')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({
    summary: 'Get subjects a teacher can be assigned to for a specific class',
    description:
      'Returns subjects from teacher competencies, indicating which are already assigned to the class',
  })
  @ApiQuery({ name: 'classId', required: true, description: 'Class or ClassArm ID' })
  @ApiResponse({
    status: 200,
    description: 'Assignable subjects retrieved successfully',
    type: [AssignableSubjectDto],
  })
  @ApiResponse({ status: 404, description: 'Teacher not found' })
  async getAssignableSubjects(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @Query('classId') classId: string
  ): Promise<ResponseDto<AssignableSubjectDto[]>> {
    const data = await this.teacherSubjectsService.getAssignableSubjects(
      schoolId,
      teacherId,
      classId
    );
    return ResponseDto.ok(data, 'Assignable subjects retrieved successfully');
  }

  // Principal endpoints
  @Patch('admins/:adminId/make-principal')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Make an admin the principal (switches current principal to admin)' })
  @ApiResponse({
    status: 200,
    description: 'Admin successfully made principal',
  })
  @ApiResponse({ status: 404, description: 'School or admin not found' })
  @ApiResponse({
    status: 400,
    description: 'Admin is already principal or invalid request',
  })
  async makePrincipal(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string,
    @Body() dto: MakePrincipalDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<void>> {
    await this.adminService.makePrincipal(schoolId, adminId, dto, user);
    return ResponseDto.ok(undefined, 'Administrator successfully made principal');
  }

  @Patch('admins/:adminId/access-tier')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({
    summary: 'Grant or remove principal-level access (School Owner only)',
    description:
      'Authority lives on the tier, not the job title. Removing principal-level ' +
      'access requires the access the admin should keep, so nobody is left with ' +
      'an empty dashboard.',
  })
  @ApiResponse({ status: 200, description: 'Access level changed' })
  @ApiResponse({
    status: 400,
    description: 'Already at that tier, no replacement access supplied, or the target is the School Owner',
  })
  @ApiResponse({ status: 403, description: 'Only the School Owner can change access levels' })
  async changeAccessTier(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string,
    @Body() dto: ChangeAccessTierDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<void>> {
    await this.adminService.changeAccessTier(schoolId, adminId, dto, user);
    return ResponseDto.ok(
      undefined,
      dto.accessTier === 'PRINCIPAL'
        ? 'Administrator now has principal-level access'
        : 'Administrator moved to staff-level access',
    );
  }

  // Role templates — named access bundles ("what a Bursar here can see").
  @Get('role-templates')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({
    summary: 'Platform built-in and school-defined access bundles',
    description:
      'Read-level, because the Add Admin and permission screens need these to ' +
      'describe access without asking anyone to rebuild it from tick-boxes.',
  })
  async listRoleTemplates(
    @Param('schoolId') schoolId: string
  ): Promise<ResponseDto<RoleTemplateDto[]>> {
    const data = await this.roleTemplateService.list(schoolId);
    return ResponseDto.ok(data, 'Role templates retrieved successfully');
  }

  @Post('role-templates')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Create a school-defined access bundle' })
  @ApiResponse({ status: 409, description: 'A role with that name already exists' })
  async createRoleTemplate(
    @Param('schoolId') schoolId: string,
    @Body() dto: CreateSchoolRoleTemplateDto
  ): Promise<ResponseDto<unknown>> {
    const data = await this.roleTemplateService.create(schoolId, dto);
    return ResponseDto.ok(data, 'Role created');
  }

  @Patch('role-templates/:templateId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({
    summary: 'Edit a school-defined access bundle',
    description:
      'Does not change anyone who already holds it — holders carry their own ' +
      'copy of the access. Use reapply to push the change to them.',
  })
  @ApiResponse({ status: 400, description: 'Built-in roles cannot be edited' })
  async updateRoleTemplate(
    @Param('schoolId') schoolId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateSchoolRoleTemplateDto
  ): Promise<ResponseDto<unknown>> {
    const data = await this.roleTemplateService.update(schoolId, templateId, dto);
    return ResponseDto.ok(data, 'Role updated');
  }

  @Delete('role-templates/:templateId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({
    summary: 'Delete a school-defined access bundle',
    description: 'Holders keep their access; they just stop being described by this role.',
  })
  async deleteRoleTemplate(
    @Param('schoolId') schoolId: string,
    @Param('templateId') templateId: string
  ): Promise<ResponseDto<void>> {
    await this.roleTemplateService.remove(schoolId, templateId);
    return ResponseDto.ok(undefined, 'Role deleted');
  }

  @Post('role-templates/:templateId/reapply')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({
    summary: 'Push this role\'s current access back onto everyone who holds it',
    description:
      'Skips admins whose access was hand-edited since, unless includeCustomised ' +
      'is set. Principal-level holders are always skipped — their access does not ' +
      'come from permission rows.',
  })
  async reapplyRoleTemplate(
    @Param('schoolId') schoolId: string,
    @Param('templateId') templateId: string,
    @Body() dto: ReapplyRoleTemplateDto
  ): Promise<ResponseDto<{ updated: number; skippedCustomised: number; skippedPrincipals: number }>> {
    const data = await this.roleTemplateService.reapply(schoolId, templateId, dto);
    return ResponseDto.ok(
      data,
      `Applied to ${data.updated} ${data.updated === 1 ? 'administrator' : 'administrators'}`,
    );
  }

  @Patch('principal/:principalId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Update a principal in a school' })
  @ApiResponse({
    status: 200,
    description: 'Principal updated successfully',
  })
  @ApiResponse({ status: 404, description: 'School or principal not found' })
  async updatePrincipal(
    @Param('schoolId') schoolId: string,
    @Param('principalId') principalId: string,
    @Body() updatePrincipalDto: UpdatePrincipalDto
  ): Promise<ResponseDto<any>> {
    const data = await this.adminService.updatePrincipal(schoolId, principalId, updatePrincipalDto);
    return ResponseDto.ok(data, 'Principal updated successfully');
  }

  @Delete('principal/:principalId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Delete a principal from a school' })
  @ApiResponse({
    status: 200,
    description: 'Principal deleted successfully',
  })
  @ApiResponse({ status: 404, description: 'School or principal not found' })
  @ApiResponse({
    status: 400,
    description: 'Cannot delete principal without another administrator to assign the role to',
  })
  async deletePrincipal(
    @Param('schoolId') schoolId: string,
    @Param('principalId') principalId: string
  ): Promise<ResponseDto<void>> {
    await this.adminService.deletePrincipal(schoolId, principalId);
    return ResponseDto.ok(undefined, 'Principal deleted successfully');
  }

  // Convert teacher to admin
  @Patch('teachers/:teacherId/convert-to-admin')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Convert a teacher to an admin (optionally keep teacher role)' })
  @ApiResponse({
    status: 200,
    description: 'Teacher successfully converted to admin',
  })
  @ApiResponse({ status: 404, description: 'School or teacher not found' })
  @ApiResponse({
    status: 400,
    description: 'Teacher is already an admin or invalid request',
  })
  async convertTeacherToAdmin(
    @Param('schoolId') schoolId: string,
    @Param('teacherId') teacherId: string,
    @Body() dto: ConvertTeacherToAdminDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<void>> {
    await this.adminService.convertTeacherToAdmin(schoolId, teacherId, dto.role, dto.keepAsTeacher, user);
    return ResponseDto.ok(undefined, 'Teacher successfully converted to administrator');
  }

  // Permission endpoints

  /**
   * Get current admin's own permissions - NO permission check required
   * This allows admins to fetch their own permissions for UI rendering
   */
  @Get('permissions/me')
  @ApiOperation({ summary: "Get current admin's own permissions" })
  @ApiResponse({
    status: 200,
    description: 'Current admin permissions retrieved successfully',
  })
  async getMyPermissions(
    @Param('schoolId') schoolId: string,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    // Get the current admin's profileId from the JWT
    const adminId = user.currentProfileId;
    if (!adminId) {
      throw new NotFoundException('Admin profile not found in token');
    }
    const data = await this.permissionService.getAdminPermissions(schoolId, adminId);
    return ResponseDto.ok(data, 'Permissions retrieved successfully');
  }

  @Get('permissions')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({ summary: 'Get all available permissions' })
  @ApiResponse({
    status: 200,
    description: 'List of all available permissions',
  })
  async getAllPermissions(): Promise<ResponseDto<any[]>> {
    const data = await this.permissionService.getAllPermissions();
    return ResponseDto.ok(data, 'Permissions retrieved successfully');
  }

  @Get('admins/:adminId/permissions')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({ summary: 'Get permissions for a specific admin' })
  @ApiResponse({
    status: 200,
    description: 'Admin permissions retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  async getAdminPermissions(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string
  ): Promise<ResponseDto<any>> {
    const data = await this.permissionService.getAdminPermissions(schoolId, adminId);
    return ResponseDto.ok(data, 'Admin permissions retrieved successfully');
  }

  @Post('admins/:adminId/permissions')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Assign permissions to an admin' })
  @ApiResponse({
    status: 200,
    description: 'Permissions assigned successfully',
  })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  @ApiResponse({ status: 400, description: 'Invalid permission IDs' })
  @ApiResponse({ status: 403, description: 'Insufficient privileges to assign these permissions' })
  async assignPermissions(
    @Param('schoolId') schoolId: string,
    @Param('adminId') adminId: string,
    @Body() dto: AssignPermissionsDto,
    @CurrentUser() user: UserWithContext,
    @Ip() ip: string
  ): Promise<ResponseDto<any>> {
    const data = await this.permissionService.assignPermissions(
      schoolId,
      adminId,
      dto.permissionIds,
      user,
      ip
    );
    return ResponseDto.ok(data, 'Permissions assigned successfully');
  }

  // Migrate existing admins to have default READ permissions
  @Post('permissions/migrate')
  @RequirePermission(PermissionResource.STAFF, PermissionType.ADMIN)
  @ApiOperation({
    summary: 'Migrate existing admins to have default READ permissions',
    description:
      "Assigns default READ permissions to all admins who don't have any permissions yet. Skips Principals (they have permanent full access).",
  })
  @ApiResponse({
    status: 200,
    description: 'Migration completed successfully',
  })
  async migrateAdminPermissions(
    @Param('schoolId') schoolId: string
  ): Promise<ResponseDto<{ migrated: number; skipped: number }>> {
    const result = await this.permissionService.migrateExistingAdmins(schoolId);
    return ResponseDto.ok(
      result,
      `Migration complete: ${result.migrated} admins updated, ${result.skipped} skipped`
    );
  }

  // Get single staff member (teacher or admin)
  @Get('staff/:staffId')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({ summary: 'Get a single staff member by ID (teacher or admin)' })
  @ApiResponse({
    status: 200,
    description: 'Staff member retrieved successfully',
  })
  @ApiResponse({ status: 404, description: 'Staff member not found' })
  async getStaffMember(
    @Param('schoolId') schoolId: string,
    @Param('staffId') staffId: string
  ): Promise<ResponseDto<any>> {
    // Try to find as admin first
    const admin = await this.adminService.getAdminById(schoolId, staffId);
    if (admin) {
      return ResponseDto.ok({ ...admin, type: 'admin' }, 'Staff member retrieved successfully');
    }

    // Try to find as teacher
    const teacher = await this.teacherService.getTeacherById(schoolId, staffId);
    if (teacher) {
      return ResponseDto.ok({ ...teacher, type: 'teacher' }, 'Staff member retrieved successfully');
    }

    throw new NotFoundException('Staff member not found');
  }

  // Bulk import staff
  @Post('staff/bulk-import')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max for bulk import files
      },
    })
  )
  @ApiOperation({
    summary: 'Bulk import staff from CSV/Excel file',
    description:
      'Upload a CSV or Excel file to import multiple staff members (teachers and admins) at once. Each row must specify type as "teacher" or "admin". Maximum file size: 10MB.',
  })
  @ApiResponse({
    status: 200,
    description: 'Bulk import completed',
    type: ResponseDto<StaffImportSummaryDto>,
  })
  @ApiResponse({ status: 400, description: 'Invalid file format or missing required fields' })
  async bulkImportStaff(
    @Param('schoolId') schoolId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: UserWithContext,
    @Query('schoolType') schoolType?: string
  ): Promise<ResponseDto<StaffImportSummaryDto>> {
    const data = await this.staffImportService.bulkImportStaff(schoolId, file, user, schoolType);
    return ResponseDto.ok(data, 'Bulk import completed');
  }

  // Resend password reset email for staff
  @Post('staff/:staffId/resend-password-reset')
  @RequirePermission(PermissionResource.STAFF, PermissionType.WRITE)
  @ApiOperation({ summary: 'Resend password reset email for a staff member' })
  @ApiResponse({
    status: 200,
    description: 'Password reset email resent successfully',
  })
  @ApiResponse({ status: 404, description: 'Staff member not found' })
  @ApiResponse({ status: 400, description: 'Staff member does not have an email address' })
  @ApiResponse({
    status: 503,
    description: 'Email service is temporarily unavailable',
  })
  async resendPasswordResetForStaff(
    @Param('schoolId') schoolId: string,
    @Param('staffId') staffId: string
  ): Promise<ResponseDto<void>> {
    // Get staff member to find userId
    const admin = await this.adminService.getAdminById(schoolId, staffId);
    let userId: string | undefined;

    if (admin) {
      userId = admin.userId;
    } else {
      const teacher = await this.teacherService.getTeacherById(schoolId, staffId);
      if (teacher) {
        userId = teacher.userId;
      } else {
        throw new NotFoundException('Staff member not found');
      }
    }

    if (!userId) {
      throw new NotFoundException('User ID not found for staff member');
    }

    try {
      await this.authService.resendPasswordResetEmail(userId, schoolId);
      return ResponseDto.ok(undefined, 'Password setup email resent successfully');
    } catch (error: any) {
      // Handle SMTP/email connection errors with user-friendly messages
      if (this.isEmailServiceError(error)) {
        throw new ServiceUnavailableException(
          'Unable to send email at this time. The email service is temporarily unavailable. Please try again later or contact support if the issue persists.'
        );
      }

      // Re-throw HTTP exceptions (like NotFoundException, BadRequestException) as-is
      if (error instanceof NotFoundException || error instanceof HttpException) {
        throw error;
      }

      // For any other unexpected errors, throw a generic service unavailable error
      throw new ServiceUnavailableException(
        'Failed to send email. Please try again later or contact support if the issue persists.'
      );
    }
  }

  /**
   * Check if an error is related to email service (SMTP connection issues)
   */
  private isEmailServiceError(error: any): boolean {
    // Check for network connection errors
    if (
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EHOSTUNREACH'
    ) {
      return true;
    }

    // Check for SMTP-specific errors
    if (
      error.message &&
      (error.message.includes('SMTP') ||
        error.message.includes('email service') ||
        error.message.includes('mail server') ||
        error.message.includes('connection timeout') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT'))
    ) {
      return true;
    }

    return false;
  }
}
