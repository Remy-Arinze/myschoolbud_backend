import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CurrentActivityDto } from '../../common/dto/current-activity.dto';
import { AccountStatusCountsDto } from '../../common/dto/pagination.dto';
import { AdminAccessTier } from './permission.dto';

export class StaffListItemDto {
  @ApiProperty({ description: 'Staff ID' })
  id: string;

  @ApiProperty({ description: 'Staff type: teacher or admin' })
  type: 'teacher' | 'admin';

  @ApiProperty({ description: 'First name' })
  firstName: string;

  @ApiProperty({ description: 'Last name' })
  lastName: string;

  @ApiProperty({ description: 'Email address', nullable: true })
  email: string | null;

  @ApiProperty({ description: 'Phone number' })
  phone: string;

  @ApiProperty({ description: 'Role (for admins) or "Teacher"', nullable: true })
  role: string | null;

  @ApiProperty({
    description:
      'Authority tier for admins. PRINCIPAL bypasses the permission tables. ' +
      'Null for teachers, who are not admins at all.',
    enum: AdminAccessTier,
    nullable: true,
  })
  accessTier: AdminAccessTier | null;

  @ApiProperty({ description: 'Subject (for teachers)', nullable: true })
  subject: string | null;

  @ApiProperty({ description: 'Employee ID', nullable: true })
  employeeId: string | null;

  @ApiProperty({ description: 'Is temporary (for teachers)' })
  isTemporary: boolean;

  @ApiProperty({ description: 'Account status (simplified)' })
  status: 'active' | 'inactive';

  @ApiProperty({
    description:
      'Account activation status (SHADOW=pending, ACTIVE=activated, SUSPENDED, ARCHIVED)',
  })
  accountStatus: 'SHADOW' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

  @ApiProperty({ description: 'Profile image URL', nullable: true })
  profileImage: string | null;

  @ApiProperty({ description: 'School type this admin is scoped to', nullable: true })
  schoolType: string | null;

  @ApiProperty({
    description: 'Assigned class info for PRIMARY teachers (id + name)',
    nullable: true,
    required: false,
  })
  assignedClass?: { id: string; name: string } | null;

  @ApiPropertyOptional({ description: 'Current live activity from timetable', type: CurrentActivityDto, nullable: true })
  currentActivity?: CurrentActivityDto | null;

  @ApiProperty({ description: 'Created date' })
  createdAt: Date;
}

export class StaffListMetaDto {
  @ApiProperty({ description: 'Total number of staff' })
  total: number;

  @ApiProperty({ description: 'Current page' })
  page: number;

  @ApiProperty({ description: 'Items per page' })
  limit: number;

  @ApiProperty({ description: 'Total pages' })
  totalPages: number;

  @ApiProperty({ description: 'Has next page' })
  hasNext: boolean;

  @ApiProperty({ description: 'Has previous page' })
  hasPrev: boolean;

  @ApiProperty({
    description: 'Status totals for the full filtered staff list, not the current page',
    type: AccountStatusCountsDto,
  })
  statusCounts: AccountStatusCountsDto;
}

export class StaffListResponseDto {
  @ApiProperty({ description: 'List of staff', type: [StaffListItemDto] })
  items: StaffListItemDto[];

  @ApiProperty({ description: 'Pagination metadata', type: StaffListMetaDto })
  meta: StaffListMetaDto;

  @ApiProperty({ description: 'Available roles for filtering', type: [String] })
  availableRoles: string[];
}

export class GetStaffListQueryDto {
  @ApiProperty({ description: 'Page number', required: false, default: 1 })
  page?: number;

  @ApiProperty({ description: 'Items per page', required: false, default: 10 })
  limit?: number;

  @ApiProperty({ description: 'Search query (name, email, subject)', required: false })
  search?: string;

  @ApiProperty({ description: 'Filter by role', required: false })
  role?: string;

  @ApiProperty({
    description: 'Filter by school type (PRIMARY, SECONDARY, TERTIARY)',
    required: false,
  })
  schoolType?: string;

  @ApiProperty({
    description:
      'Filter the list by account status. Status KPI counts ignore this and cover the full filtered set.',
    required: false,
    enum: ['active', 'pending', 'suspended'],
  })
  status?: 'active' | 'pending' | 'suspended';
}
