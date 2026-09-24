import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SchoolDataAccessGuard } from '../common/guards/school-data-access.guard';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/permission.decorator';
import { PermissionResource, PermissionType } from '../schools/dto/permission.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserWithContext } from '../auth/types/user-with-context.type';
import { ResponseDto } from '../common/dto/response.dto';
import { GradesService } from './grades.service';
import { CreateGradeDto, UpdateGradeDto, BulkGradeEntryDto, GradeType } from './dto/grade.dto';
import { Throttle } from '@nestjs/throttler';

/**
 * database-intensive tier: Grade management often involves bulk operations,
 * aggregations for transcripts, and class-wide performance results.
 */
@ApiTags('grades')
@Controller('schools/:schoolId/grades')
@UseGuards(JwtAuthGuard, SchoolDataAccessGuard, PermissionGuard)
@ApiBearerAuth()
@Throttle({ 'database-intensive': { limit: 60, ttl: 60000 } })
export class GradesController {
  constructor(private readonly gradesService: GradesService) {}

  @Post()
  @RequirePermission(PermissionResource.GRADES, PermissionType.WRITE)
  @ApiOperation({ summary: 'Create a new grade' })
  @ApiResponse({
    status: 201,
    description: 'Grade created successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({
    status: 403,
    description: 'Teacher not authorized to create grade for this subject',
  })
  async createGrade(
    @Param('schoolId') schoolId: string,
    @Body() dto: CreateGradeDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const data = await this.gradesService.createGrade(schoolId, dto, user);
    return ResponseDto.ok(data, 'Grade created successfully');
  }

  @Patch(':gradeId')
  @RequirePermission(PermissionResource.GRADES, PermissionType.WRITE)
  @ApiOperation({ summary: 'Update a grade' })
  @ApiResponse({
    status: 200,
    description: 'Grade updated successfully',
  })
  @ApiResponse({ status: 403, description: 'Only the teacher who created the grade can update it' })
  @ApiResponse({ status: 404, description: 'Grade not found' })
  async updateGrade(
    @Param('schoolId') schoolId: string,
    @Param('gradeId') gradeId: string,
    @Body() dto: UpdateGradeDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any>> {
    const data = await this.gradesService.updateGrade(schoolId, gradeId, dto, user);
    return ResponseDto.ok(data, 'Grade updated successfully');
  }

  @Delete(':gradeId')
  @RequirePermission(PermissionResource.GRADES, PermissionType.WRITE)
  @ApiOperation({ summary: 'Delete a grade' })
  @ApiResponse({
    status: 200,
    description: 'Grade deleted successfully',
  })
  @ApiResponse({ status: 403, description: 'Only the teacher who created the grade can delete it' })
  @ApiResponse({ status: 404, description: 'Grade not found' })
  async deleteGrade(
    @Param('schoolId') schoolId: string,
    @Param('gradeId') gradeId: string,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<void>> {
    await this.gradesService.deleteGrade(schoolId, gradeId, user);
    return ResponseDto.ok(undefined, 'Grade deleted successfully');
  }

  @Post('classes/:classId/bulk')
  @RequirePermission(PermissionResource.GRADES, PermissionType.WRITE)
  @ApiOperation({ summary: 'Bulk create grades for a class' })
  @ApiResponse({
    status: 201,
    description: 'Grades created successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Teacher not authorized' })
  async bulkCreateGrades(
    @Param('schoolId') schoolId: string,
    @Param('classId') classId: string,
    @Body() dto: BulkGradeEntryDto,
    @CurrentUser() user: UserWithContext
  ): Promise<ResponseDto<any[]>> {
    // Ensure classId in DTO matches the URL parameter
    dto.classId = classId;
    const data = await this.gradesService.bulkCreateGrades(schoolId, dto, user);
    return ResponseDto.ok(data, 'Grades created successfully');
  }

  @Get('classes/:classId')
  @RequirePermission(PermissionResource.GRADES, PermissionType.READ)
  @ApiOperation({ summary: 'Get grades for a class' })
  @ApiQuery({ name: 'subject', required: false, description: 'Filter by subject' })
  @ApiQuery({ name: 'termId', required: false, description: 'Filter by term ID' })
  @ApiQuery({
    name: 'gradeType',
    required: false,
    description: 'Filter by grade type (CA, ASSIGNMENT, EXAM)',
  })
  @ApiResponse({
    status: 200,
    description: 'Grades retrieved successfully',
  })
  async getClassGrades(
    @Param('schoolId') schoolId: string,
    @Param('classId') classId: string,
    @Query('subject') subject?: string,
    @Query('termId') termId?: string,
    @Query('gradeType') gradeType?: string,
    @CurrentUser() user?: UserWithContext
  ): Promise<ResponseDto<any[]>> {
    const data = await this.gradesService.getClassGrades(
      schoolId,
      classId,
      subject,
      termId,
      gradeType,
      user
    );
    return ResponseDto.ok(data, 'Grades retrieved successfully');
  }

  @Get('classes/:classId/students')
  @RequirePermission(PermissionResource.GRADES, PermissionType.READ)
  @ApiOperation({ summary: 'Get grades grouped by students for a class' })
  @ApiQuery({ name: 'subject', required: false, description: 'Filter by subject' })
  @ApiQuery({ name: 'termId', required: false, description: 'Filter by term ID' })
  @ApiQuery({
    name: 'gradeType',
    required: false,
    description: 'Filter by grade type (CA, ASSIGNMENT, EXAM)',
  })
  @ApiQuery({
    name: 'report',
    required: false,
    description: 'When 1, a form teacher of this class receives every published grade',
  })
  @ApiResponse({
    status: 200,
    description: 'Student grades retrieved successfully',
  })
  async getClassGradesGroupedByStudents(
    @Param('schoolId') schoolId: string,
    @Param('classId') classId: string,
    @Query('subject') subject?: string,
    @Query('termId') termId?: string,
    @Query('gradeType') gradeType?: string,
    @Query('report') report?: string,
    @CurrentUser() user?: UserWithContext
  ): Promise<ResponseDto<any[]>> {
    const data = await this.gradesService.getClassGradesGroupedByStudents(
      schoolId,
      classId,
      subject,
      termId,
      gradeType,
      user,
      report === '1'
    );
    return ResponseDto.ok(data, 'Student grades retrieved successfully');
  }

  @Get('students/:studentId')
  @RequirePermission(PermissionResource.GRADES, PermissionType.READ)
  @ApiOperation({ summary: 'Get grades for a student' })
  @ApiQuery({ name: 'subject', required: false, description: 'Filter by subject' })
  @ApiResponse({
    status: 200,
    description: 'Grades retrieved successfully',
  })
  async getStudentGrades(
    @Param('schoolId') schoolId: string,
    @Param('studentId') studentId: string,
    @Query('subject') subject?: string,
    @CurrentUser() user?: UserWithContext
  ): Promise<ResponseDto<any[]>> {
    const data = await this.gradesService.getStudentGrades(schoolId, studentId, subject, user);
    return ResponseDto.ok(data, 'Grades retrieved successfully');
  }
}
