import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, Max } from 'class-validator';

export class PaginationDto {
  @ApiProperty({
    description: 'Page number (1-indexed)',
    example: 1,
    required: false,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({
    description: 'Number of items per page',
    example: 10,
    required: false,
    default: 10,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiProperty({
    description: 'Search query (searches in name, subdomain, city, state)',
    example: 'test',
    required: false,
  })
  @IsOptional()
  search?: string;

  @ApiProperty({
    description: 'Filter by status',
    example: 'active',
    enum: ['all', 'active', 'inactive'],
    required: false,
    default: 'all',
  })
  @IsOptional()
  filter?: 'all' | 'active' | 'inactive' = 'all';
}

/** Full-list account status totals. These are not limited to the current page. */
export class AccountStatusCountsDto {
  @ApiProperty({ description: 'Accounts with status ACTIVE' })
  active: number;

  @ApiProperty({ description: 'Accounts with status SHADOW (invited, not yet activated)' })
  pending: number;

  @ApiProperty({ description: 'Accounts with status SUSPENDED' })
  suspended: number;

  @ApiProperty({ description: 'Accounts with status ARCHIVED' })
  archived: number;
}

export class PaginatedResponseDto<T> {
  @ApiProperty({ description: 'Array of items' })
  data: T[];

  @ApiProperty({ description: 'Total number of items' })
  total: number;

  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of items per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;

  @ApiProperty({ description: 'Whether there is a next page' })
  hasNext: boolean;

  @ApiProperty({ description: 'Whether there is a previous page' })
  hasPrev: boolean;

  @ApiPropertyOptional({
    description: 'Status totals for the full filtered set, not the current page',
    type: AccountStatusCountsDto,
  })
  statusCounts?: AccountStatusCountsDto;
}
