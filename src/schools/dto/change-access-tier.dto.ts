import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AdminPermissionDto } from './add-admin.dto';
import { AdminAccessTier } from './permission.dto';

/**
 * Change who bypasses the permission system.
 *
 * Dropping someone to STAFF must say what they keep. Before the tier existed, a
 * demotion was a title edit that silently left the person with zero permission
 * rows and a dashboard with nothing in it — so a replacement set is required
 * here, not optional.
 */
export class ChangeAccessTierDto {
  @ApiProperty({
    enum: AdminAccessTier,
    description: 'The tier to move this admin to.',
  })
  @IsEnum(AdminAccessTier)
  accessTier: AdminAccessTier;

  @ApiPropertyOptional({
    description:
      'Exact permissions to leave the admin with. Required when moving to STAFF ' +
      'unless roleTemplateId is given. Send [] only to deliberately leave them ' +
      'with no dashboard access.',
    type: [AdminPermissionDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionDto)
  permissions?: AdminPermissionDto[];

  @ApiPropertyOptional({
    description:
      'Role template to apply instead of listing permissions. Required when ' +
      'moving to STAFF unless permissions is given.',
  })
  @IsOptional()
  @IsString()
  roleTemplateId?: string;

  @ApiPropertyOptional({
    description:
      'New job title to land on. Optional — the title is only a label, so this ' +
      'changes nothing about access. Useful so a demoted Principal is not still ' +
      'called Principal.',
  })
  @IsOptional()
  @IsString()
  role?: string;
}

/**
 * Promote an admin to Principal.
 *
 * If the school already has a sitting Principal, they are stepped down as part
 * of the same action — so the caller has to say what that person keeps.
 */
export class MakePrincipalDto {
  @ApiPropertyOptional({
    description:
      'Access the outgoing principal keeps. Required when a principal is already ' +
      'in post, unless incumbentRoleTemplateId is given.',
    type: [AdminPermissionDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminPermissionDto)
  incumbentPermissions?: AdminPermissionDto[];

  @ApiPropertyOptional({
    description: 'Role template to apply to the outgoing principal.',
  })
  @IsOptional()
  @IsString()
  incumbentRoleTemplateId?: string;
}
