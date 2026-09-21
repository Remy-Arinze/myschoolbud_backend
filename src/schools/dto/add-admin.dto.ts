import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsArray, IsEnum, ValidateNested, MinLength, MaxLength, IsNotEmpty } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { AdminAccessTier, PermissionResource, PermissionType } from './permission.dto';
import {
  sanitizeString,
  sanitizeOptionalString,
  sanitizeEmail,
  sanitizePhone,
} from '../../common/utils/sanitize.util';

/**
 * Represents a single permission assignment for the new admin
 */
export class AdminPermissionDto {
  @ApiProperty({
    description: 'The resource to grant permission for',
    enum: PermissionResource,
    example: PermissionResource.STUDENTS,
  })
  @IsString()
  resource: PermissionResource;

  @ApiProperty({
    description: 'The permission type (READ, WRITE, or ADMIN)',
    enum: PermissionType,
    example: PermissionType.READ,
  })
  @IsString()
  type: PermissionType;
}

export class AddAdminDto {
  @ApiProperty({ description: 'Admin first name' })
  @IsString({ message: 'First name must be a string' })
  @IsNotEmpty({ message: 'First name is required' })
  @MaxLength(50, { message: 'First name cannot exceed 50 characters' })
  @Transform(({ value }) => sanitizeString(value, 50))
  firstName: string;

  @ApiProperty({ description: 'Admin last name' })
  @IsString({ message: 'Last name must be a string' })
  @IsNotEmpty({ message: 'Last name is required' })
  @MaxLength(50, { message: 'Last name cannot exceed 50 characters' })
  @Transform(({ value }) => sanitizeString(value, 50))
  lastName: string;

  @ApiProperty({ description: 'Admin email' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Admin email is required' })
  @MaxLength(255, { message: 'Email cannot exceed 255 characters' })
  @Transform(({ value }) => sanitizeEmail(value) ?? value ?? '')
  email: string;

  @ApiProperty({ description: 'Admin phone number' })
  @IsString({ message: 'Phone number must be a string' })
  @IsNotEmpty({ message: 'Phone number is required' })
  @MinLength(7, { message: 'Phone number must be at least 7 characters' })
  @MaxLength(20, { message: 'Phone number cannot exceed 20 characters' })
  @Transform(({ value }) => sanitizePhone(value) ?? '')
  phone: string;

  @ApiProperty({
    description:
      'Admin role (can be enum value or custom role string like "Bursar", "Vice Principal", etc.)',
    example: 'BURSAR or "Dean of Students"',
  })
  @IsString({ message: 'Role must be a string' })
  @IsNotEmpty({ message: 'Role is required' })
  @MaxLength(50, { message: 'Role cannot exceed 50 characters' })
  @Transform(({ value }) => sanitizeString(value, 50))
  role: string; // Changed to string to accept custom roles

  @ApiPropertyOptional({ description: 'Profile image URL (Cloudinary)' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @Transform(({ value }) => sanitizeOptionalString(value, 2048))
  profileImage?: string;

  @ApiPropertyOptional({ description: 'Employee ID (optional internal identifier)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(({ value }) => sanitizeOptionalString(value, 50))
  employeeId?: string;

  @ApiPropertyOptional({
    description:
      'Exact permissions to assign. Send [] for an admin with no dashboard access. ' +
      'Either this or roleTemplateId is required — access is never granted by default.',
    type: [AdminPermissionDto],
    example: [
      { resource: 'STUDENTS', type: 'READ' },
      { resource: 'STUDENTS', type: 'WRITE' },
      { resource: 'CLASSES', type: 'READ' },
    ],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionDto)
  permissions?: AdminPermissionDto[];

  @ApiPropertyOptional({
    description:
      'Role template to apply. Alternative to sending `permissions` explicitly. ' +
      'The admin is recorded as holding this template so drift is visible later.',
  })
  @IsOptional()
  @IsString()
  roleTemplateId?: string;

  @ApiPropertyOptional({
    description:
      'Authority tier. Omitted means STAFF. PRINCIPAL bypasses the permission ' +
      'tables entirely and is School-Owner-only — a principal-sounding job title ' +
      'grants nothing on its own.',
    enum: AdminAccessTier,
  })
  @IsOptional()
  @IsEnum(AdminAccessTier)
  accessTier?: AdminAccessTier;

  @ApiPropertyOptional({
    description: 'School type this admin is scoped to (PRIMARY, SECONDARY, TERTIARY). If not provided, admin is school-wide.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  schoolType?: string;
}
