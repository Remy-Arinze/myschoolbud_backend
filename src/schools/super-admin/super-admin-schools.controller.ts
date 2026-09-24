import { Controller, Get, Post, Patch, Body, Param, UseGuards, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SuperAdminSchoolsService } from './super-admin-schools.service';
import { CreateSchoolDto } from '../dto/create-school.dto';
import { UpdateSchoolDto } from '../dto/update-school.dto';
import { SchoolDto } from '../dto/school.dto';
import { ResponseDto } from '../../common/dto/response.dto';
import { PaginationDto, PaginatedResponseDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../database/prisma.service';
import { ScheduleCloseDto } from '../dto/schedule-close.dto';

/**
 * standard tier: Super Admin management of school entities.
 */
@ApiTags('schools')
@Controller('schools')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@ApiBearerAuth()
@Throttle({ standard: {} })
export class SuperAdminSchoolsController {
  constructor(
    private readonly superAdminSchoolsService: SuperAdminSchoolsService,
    private readonly prisma: PrismaService,
  ) { }

  @Post()
  @ApiOperation({ summary: 'Create a new school (Super Admin only)' })
  @ApiResponse({
    status: 201,
    description: 'School created successfully',
    type: ResponseDto<SchoolDto>,
  })
  @ApiResponse({ status: 409, description: 'School already exists' })
  async createSchool(@Body() createSchoolDto: CreateSchoolDto): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.createSchool(createSchoolDto);
    return ResponseDto.ok(data, 'School created successfully');
  }

  @Get()
  @ApiOperation({ summary: 'Get all schools with pagination (Super Admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 10, max: 100)' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by name, city, or state' })
  @ApiQuery({ name: 'filter', required: false, enum: ['all', 'active', 'inactive'], description: 'Filter by status (default: all)' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of schools',
    type: ResponseDto<PaginatedResponseDto<SchoolDto>>,
  })
  async findAll(@Query() query: PaginationDto) {
    const data = await this.superAdminSchoolsService.findAll(query);
    return ResponseDto.ok(data, 'Schools retrieved successfully');
  }

  @Get('pending')
  @ApiOperation({ summary: 'Get all pending school registrations (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'List of pending schools',
    type: ResponseDto<SchoolDto[]>,
  })
  async getPendingSchools(): Promise<ResponseDto<SchoolDto[]>> {
    const data = await this.superAdminSchoolsService.findPendingSchools();
    return ResponseDto.ok(data, 'Pending schools retrieved successfully');
  }

  @Get(':id/subscription-tier')
  @ApiOperation({ summary: 'Get a school\'s current subscription tier (Super Admin only)' })
  @ApiResponse({ status: 200, description: 'Subscription tier' })
  async getSchoolSubscriptionTier(
    @Param('id') id: string,
  ): Promise<ResponseDto<{ tier: string; isActive: boolean }>> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { schoolId: id },
      orderBy: { createdAt: 'desc' },
      select: { tier: true, isActive: true },
    });
    return ResponseDto.ok(
      { tier: subscription?.tier ?? 'FREE', isActive: subscription?.isActive ?? false },
      'Subscription tier retrieved successfully',
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get school by ID (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'School details',
    type: ResponseDto<SchoolDto>,
  })
  @ApiResponse({ status: 404, description: 'School not found' })
  async findOne(@Param('id') id: string): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.findOne(id);
    return ResponseDto.ok(data, 'School retrieved successfully');
  }

  @Patch(':id/verify')
  @ApiOperation({ summary: 'Verify a pending school registration (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'School verified successfully',
    type: ResponseDto<SchoolDto>,
  })
  async verifySchool(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.verifySchool(id, req.user.id);
    return ResponseDto.ok(data, 'School verified successfully');
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a pending school registration (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'School rejected successfully',
    type: ResponseDto<SchoolDto>,
  })
  async rejectSchool(
    @Param('id') id: string,
    @Body('reason') reason: string,
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.rejectSchool(id, reason);
    return ResponseDto.ok(data, 'School rejected successfully');
  }

  @Patch(':id/slug')
  @ApiOperation({ summary: 'Rename a school portal slug (Super Admin only)' })
  async renameSlug(
    @Param('id') id: string,
    @Body('slug') slug: string,
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.renameSlug(id, slug);
    return ResponseDto.ok(data, 'Portal address updated');
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Reactivate a deactivated school (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'School reactivated successfully',
    type: ResponseDto<SchoolDto>,
  })
  async activateSchool(@Param('id') id: string): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.activateSchool(id);
    return ResponseDto.ok(data, 'School reactivated successfully');
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Schedule a school close with a 7-day delay (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'School close scheduled',
    type: ResponseDto<SchoolDto>,
  })
  async deactivateSchool(
    @Param('id') id: string,
    @Body() body: ScheduleCloseDto,
    @Req() req: any,
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.deactivateSchool(id, body.reason, req.user.id);
    return ResponseDto.ok(data, 'School close scheduled. The school stays available for 7 days.');
  }

  @Post(':id/close/cancel')
  @ApiOperation({ summary: 'Cancel a scheduled school close (Super Admin only)' })
  async cancelClose(@Param('id') id: string): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.cancelClose(id);
    return ResponseDto.ok(data, 'School close cancelled');
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a school (Super Admin only)' })
  @ApiResponse({
    status: 200,
    description: 'School updated successfully',
    type: ResponseDto<SchoolDto>,
  })
  @ApiResponse({ status: 404, description: 'School not found' })
  @ApiResponse({ status: 409, description: 'School already exists' })
  async updateSchool(
    @Param('id') id: string,
    @Body() updateSchoolDto: UpdateSchoolDto
  ): Promise<ResponseDto<SchoolDto>> {
    const data = await this.superAdminSchoolsService.updateSchool(id, updateSchoolDto);
    return ResponseDto.ok(data, 'School updated successfully');
  }

}
