import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdminPermissionDto } from './add-admin.dto';
import { PermissionDto } from './permission.dto';

export class CreateSchoolRoleTemplateDto {
  @ApiProperty({ description: 'What the school calls this role, e.g. "Bursar".' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ description: 'One line on what this role is for.' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional({
    description: 'Job title to prefill when this template is chosen. Only a label.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  suggestedRole?: string;

  @ApiProperty({
    description: 'The access this role carries.',
    type: [AdminPermissionDto],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'A role template needs at least one permission' })
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionDto)
  permissions: AdminPermissionDto[];
}

export class UpdateSchoolRoleTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  suggestedRole?: string;

  @ApiPropertyOptional({ type: [AdminPermissionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionDto)
  permissions?: AdminPermissionDto[];
}

export class ReapplyRoleTemplateDto {
  @ApiPropertyOptional({
    description:
      'Include admins whose access was hand-edited since the template was applied. ' +
      'Defaults to false, because overwriting a deliberate exception is the kind of ' +
      'surprise this feature exists to avoid.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeCustomised?: boolean;
}

export class RoleTemplateDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiPropertyOptional({ nullable: true })
  suggestedRole: string | null;

  @ApiProperty({
    description: 'True for the platform bundles every school starts with. Not editable.',
  })
  isBuiltIn: boolean;

  @ApiProperty({ type: [PermissionDto], description: 'The access this role carries.' })
  permissions: PermissionDto[];

  @ApiProperty({ description: 'How many admins in this school currently hold it.' })
  holderCount: number;

  @ApiProperty({ description: 'How many holders have since had their access hand-edited.' })
  customisedHolderCount: number;
}
