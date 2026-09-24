import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsIn, IsString } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ClassType } from '../../schools/dto/create-class.dto';

export class GetStudentsDto extends PaginationDto {
  @ApiProperty({
    description: 'Filter by school type',
    enum: ClassType,
    required: false,
  })
  @IsOptional()
  @IsEnum(ClassType)
  schoolType?: ClassType;

  @ApiProperty({
    description: 'Search by student name, UID, or public ID',
    required: false,
  })
  @IsOptional()
  @IsString()
  search?: string = undefined;

  @ApiProperty({
    description:
      'Filter the list by account status. Status KPI counts ignore this and cover the full filtered set.',
    required: false,
    enum: ['active', 'pending', 'suspended'],
  })
  @IsOptional()
  @IsIn(['active', 'pending', 'suspended'])
  status?: 'active' | 'pending' | 'suspended';
}
