import {
  Controller,
  Get,
  Post,
  Patch,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  Query,
  Body,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiConsumes,
} from '@nestjs/swagger';
import { SchoolAdminSchoolsService } from './school-admin-schools.service';
import { SchoolLifecycleService } from '../lifecycle/school-lifecycle.service';
import { ScheduleCloseDto } from '../dto/schedule-close.dto';
import { SchoolDto } from '../dto/school.dto';
import { SchoolDashboardDto, SchoolDashboardChartsDto } from '../dto/dashboard.dto';
import { SchoolSetupProgressDto } from '../dto/setup-progress.dto';
import { StaffListResponseDto } from '../dto/staff-list.dto';
import { UpdateSchoolDto } from '../dto/update-school.dto';
import { ResponseDto } from '../../common/dto/response.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { SchoolDataAccessGuard } from '../../common/guards/school-data-access.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/permission.decorator';
import { PermissionResource, PermissionType } from '../dto/permission.dto';

/**
 * standard tier: School Admin dashboard and profile management.
 * Sensitive configuration changes have stricter overrides.
 */
@ApiTags('school-admin')
@Controller('school-admin')
@UseGuards(JwtAuthGuard, SchoolDataAccessGuard, PermissionGuard)
@ApiBearerAuth()
@Throttle({ standard: {} })
export class SchoolAdminSchoolsController {
  constructor(
    private readonly schoolAdminSchoolsService: SchoolAdminSchoolsService,
    private readonly lifecycle: SchoolLifecycleService,
  ) {}

  // Note: No @RequirePermission on this endpoint - it's needed for the permission system to bootstrap
  // Access is still controlled by JwtAuthGuard and SchoolDataAccessGuard
  @Get('school')
  @ApiOperation({ summary: 'Get my school information' })
  @ApiResponse({
    status: 200,
    description: 'School information retrieved successfully',
    type: ResponseDto<SchoolDto>,
  })
  async getMySchool(@Request() req: any): Promise<ResponseDto<SchoolDto>> {
    const data = await this.schoolAdminSchoolsService.getMySchool(req.user);
    return ResponseDto.ok(data, 'School information retrieved successfully');
  }

  @Get('dashboard/charts')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
  @ApiOperation({ summary: 'Get school dashboard charts' })
  @ApiQuery({
    name: 'schoolType',
    required: false,
    type: String,
    description: 'Filter by school type (PRIMARY, SECONDARY, TERTIARY)',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard charts retrieved successfully',
    type: ResponseDto<SchoolDashboardChartsDto>,
  })
  async getDashboardCharts(
    @Request() req: any,
    @Query('schoolType') schoolType?: string
  ): Promise<ResponseDto<SchoolDashboardChartsDto>> {
    const data = await this.schoolAdminSchoolsService.getDashboardCharts(req.user, schoolType);
    return ResponseDto.ok(data, 'Dashboard charts retrieved successfully');
  }

  @Get('dashboard')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
  @ApiOperation({ summary: 'Get school dashboard data' })
  @ApiQuery({
    name: 'schoolType',
    required: false,
    type: String,
    description: 'Filter by school type (PRIMARY, SECONDARY, TERTIARY)',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard data retrieved successfully',
    type: ResponseDto<SchoolDashboardDto>,
  })
  async getDashboard(
    @Request() req: any,
    @Query('schoolType') schoolType?: string
  ): Promise<ResponseDto<SchoolDashboardDto>> {
    const data = await this.schoolAdminSchoolsService.getDashboard(req.user, schoolType);
    return ResponseDto.ok(data, 'Dashboard data retrieved successfully');
  }

  @Get('setup-progress')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.READ)
  @ApiOperation({ summary: 'Get school setup checklist progress' })
  @ApiQuery({
    name: 'schoolType',
    required: false,
    type: String,
    description: 'Filter by school type (PRIMARY, SECONDARY, TERTIARY)',
  })
  @ApiResponse({
    status: 200,
    description: 'Setup progress retrieved successfully',
    type: ResponseDto<SchoolSetupProgressDto>,
  })
  async getSetupProgress(
    @Request() req: any,
    @Query('schoolType') schoolType?: string
  ): Promise<ResponseDto<SchoolSetupProgressDto>> {
    const data = await this.schoolAdminSchoolsService.getSetupProgress(req.user, schoolType);
    return ResponseDto.ok(data, 'Setup progress retrieved successfully');
  }

  @Get('staff')
  @RequirePermission(PermissionResource.STAFF, PermissionType.READ)
  @ApiOperation({ summary: 'Get paginated staff list with search and filtering' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 10, max: 100)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search query (name, email, subject)',
  })
  @ApiQuery({ name: 'role', required: false, type: String, description: 'Filter by role' })
  @ApiQuery({
    name: 'schoolType',
    required: false,
    type: String,
    description: 'Filter by school type (PRIMARY, SECONDARY, TERTIARY)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'pending', 'suspended'],
    description: 'Filter the list by account status. KPI counts ignore this filter.',
  })
  @ApiResponse({
    status: 200,
    description: 'Staff list retrieved successfully',
    type: ResponseDto<StaffListResponseDto>,
  })
  async getStaffList(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('schoolType') schoolType?: string,
    @Query('status') status?: 'active' | 'pending' | 'suspended',
  ): Promise<ResponseDto<StaffListResponseDto>> {
    const query = {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      role,
      schoolType,
      status,
    };
    const data = await this.schoolAdminSchoolsService.getStaffList(req.user, query);
    return ResponseDto.ok(data, 'Staff list retrieved successfully');
  }

  @Post('school/logo')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    })
  )
  @ApiOperation({ summary: 'Upload school logo' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 200,
    description: 'Logo uploaded successfully',
    type: ResponseDto<SchoolDto>,
  })
  async uploadLogo(
    @Request() req: any,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.schoolAdminSchoolsService.uploadLogo(req.user, file);
    return ResponseDto.ok(data, 'Logo uploaded successfully');
  }

  @Patch('school/branding')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.WRITE)
  @ApiOperation({ summary: 'Update school portal branding' })
  async updateBranding(@Request() req: any, @Body() body: any) {
    const data = await this.schoolAdminSchoolsService.updateBranding(req.user, body);
    return ResponseDto.ok(data, 'Branding updated');
  }

  @Post('school/favicon')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.WRITE)
  @UseInterceptors(
    FileInterceptor('favicon', {
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  async uploadFavicon(@Request() req: any, @UploadedFile() file: Express.Multer.File) {
    const data = await this.schoolAdminSchoolsService.uploadFavicon(req.user, file);
    return ResponseDto.ok(data, 'Favicon uploaded');
  }

  @Post('school/custom-domain')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Request a custom domain for the school portal' })
  async requestCustomDomain(@Request() req: any, @Body('host') host: string) {
    const data = await this.schoolAdminSchoolsService.requestCustomDomain(req.user, host);
    return ResponseDto.ok(data, 'Custom domain saved. Add the DNS records to verify.');
  }

  @Post('school/custom-domain/verify')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Verify custom domain DNS' })
  async verifyCustomDomain(@Request() req: any) {
    const data = await this.schoolAdminSchoolsService.verifyCustomDomain(req.user);
    return ResponseDto.ok(data, 'Custom domain verified');
  }

  @Patch('school')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Update school information' })
  @ApiQuery({
    name: 'token',
    required: false,
    type: String,
    description: 'Verification token for sensitive changes',
  })
  @ApiResponse({
    status: 200,
    description: 'School updated successfully',
    type: ResponseDto<SchoolDto>,
  })
  async updateSchool(
    @Request() req: any,
    @Body() updateSchoolDto: UpdateSchoolDto,
    @Query('token') token?: string
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.schoolAdminSchoolsService.updateSchool(
      req.user,
      updateSchoolDto,
      token
    );
    return ResponseDto.ok(data, 'School updated successfully');
  }

  @Post('school/request-edit-token')
  @Throttle({ standard: { ttl: 3600000, limit: 5 } }) // 5 requests per hour (Strict)
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Request verification token for sensitive school profile changes' })
  @ApiResponse({
    status: 200,
    description: 'Verification token requested successfully',
  })
  async requestEditToken(
    @Request() req: any,
    @Body() changes: UpdateSchoolDto
  ): Promise<ResponseDto<{ message: string }>> {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const result = await this.schoolAdminSchoolsService.requestEditToken(
      req.user,
      changes,
      ipAddress,
      userAgent
    );
    return ResponseDto.ok({ message: result.message }, result.message);
  }

  @Post('school/verify-edit-token')
  @Throttle({ standard: { ttl: 60000, limit: 10 } }) // 10 verifications per minute (Strict)
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Verify edit token and get proposed changes' })
  @ApiResponse({
    status: 200,
    description: 'Token verified successfully',
  })
  async verifyEditToken(
    @Request() req: any,
    @Body() body: { token: string }
  ): Promise<ResponseDto<{ changes: UpdateSchoolDto; school: SchoolDto }>> {
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const data = await this.schoolAdminSchoolsService.verifyEditToken(
      body.token,
      req.user,
      ipAddress,
      userAgent
    );
    return ResponseDto.ok(data, 'Token verified successfully');
  }

  @Post('school/cleanup-expired-tokens')
  @RequirePermission(PermissionResource.OVERVIEW, PermissionType.ADMIN)
  @ApiOperation({ summary: 'Cleanup expired and used tokens (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Tokens cleaned up successfully',
  })
  async cleanupExpiredTokens(@Request() req: any): Promise<ResponseDto<{ count: number }>> {
    // Only allow super admins or system to call this
    if (req.user.role !== 'SUPER_ADMIN') {
      throw new UnauthorizedException('Only super admins can cleanup tokens');
    }
    const count = await this.schoolAdminSchoolsService.cleanupExpiredTokens();
    return ResponseDto.ok({ count }, `Cleaned up ${count} expired tokens`);
  }

  @Post('school/close')
  @ApiOperation({ summary: 'Schedule a school close (owner or principal only, 7-day delay)' })
  async scheduleClose(
    @Request() req: any,
    @Body() body: ScheduleCloseDto,
  ): Promise<ResponseDto<SchoolDto>> {
    await this.lifecycle.assertOwnerOrPrincipal(req.user.id, req.user.currentSchoolId);
    const data = await this.lifecycle.scheduleClose(req.user.currentSchoolId, body.reason, {
      userId: req.user.id,
      role: 'SCHOOL_OWNER',
    });
    return ResponseDto.ok(data, 'School close scheduled. The school stays available for 7 days.');
  }

  @Post('school/close/cancel')
  @ApiOperation({ summary: 'Cancel a scheduled school close (owner or principal only)' })
  async cancelClose(@Request() req: any): Promise<ResponseDto<SchoolDto>> {
    await this.lifecycle.assertOwnerOrPrincipal(req.user.id, req.user.currentSchoolId);
    const data = await this.lifecycle.cancelClose(req.user.currentSchoolId);
    return ResponseDto.ok(data, 'School close cancelled');
  }

  @Post('school/reactivate')
  @ApiOperation({ summary: 'Reactivate a deactivated school (owner or principal only)' })
  async reactivate(@Request() req: any): Promise<ResponseDto<SchoolDto>> {
    await this.lifecycle.assertOwnerOrPrincipal(req.user.id, req.user.currentSchoolId);
    const data = await this.lifecycle.reactivate(req.user.currentSchoolId);
    return ResponseDto.ok(data, 'School reactivated');
  }
}
