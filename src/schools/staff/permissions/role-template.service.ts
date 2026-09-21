import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import {
  PermissionResource,
  PermissionType,
  hasPrincipalAccess,
} from '../../dto/permission.dto';
import {
  CreateSchoolRoleTemplateDto,
  ReapplyRoleTemplateDto,
  RoleTemplateDto,
  UpdateSchoolRoleTemplateDto,
} from '../../dto/role-template.dto';

/**
 * Named access bundles: "what a Bursar here can see".
 *
 * A template is a copy source, not a live link. Applying one writes rows onto
 * the admin, so correcting a template never silently changes somebody's access
 * — the school re-applies it deliberately, and is told who would be affected.
 */
@Injectable()
export class RoleTemplateService {
  private readonly logger = new Logger(RoleTemplateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Platform built-ins plus this school's own, built-ins first. */
  async list(schoolId: string): Promise<RoleTemplateDto[]> {
    const [templates, catalog, holders] = await Promise.all([
      this.prisma.roleTemplate.findMany({
        where: { OR: [{ schoolId }, { schoolId: null }] },
        orderBy: [{ schoolId: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.permission.findMany(),
      this.prisma.schoolAdmin.findMany({
        where: { schoolId, roleTemplateId: { not: null } },
        select: { roleTemplateId: true, templateCustomised: true },
      }),
    ]);

    const byId = new Map(catalog.map((p) => [p.id, p]));

    return templates.map((template) => {
      const mine = holders.filter((h) => h.roleTemplateId === template.id);
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        suggestedRole: template.suggestedRole,
        isBuiltIn: template.schoolId === null,
        permissions: template.permissionIds
          .map((id) => byId.get(id))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({
            id: p.id,
            resource: p.resource as PermissionResource,
            type: p.type as PermissionType,
            description: p.description || undefined,
          })),
        holderCount: mine.length,
        customisedHolderCount: mine.filter((h) => h.templateCustomised).length,
      };
    });
  }

  async create(schoolId: string, dto: CreateSchoolRoleTemplateDto) {
    const permissionIds = await this.resolvePermissionIds(dto.permissions);
    const name = dto.name.trim();

    await this.assertNameFree(schoolId, name);

    return this.prisma.roleTemplate.create({
      data: {
        schoolId,
        name,
        description: dto.description?.trim() || null,
        suggestedRole: dto.suggestedRole?.trim() || null,
        permissionIds,
        isSystem: false,
      },
    });
  }

  async update(schoolId: string, templateId: string, dto: UpdateSchoolRoleTemplateDto) {
    const template = await this.ownTemplate(schoolId, templateId);
    const name = dto.name?.trim();

    if (name && name !== template.name) {
      await this.assertNameFree(schoolId, name);
    }

    return this.prisma.roleTemplate.update({
      where: { id: template.id },
      data: {
        ...(name ? { name } : {}),
        ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        ...(dto.suggestedRole !== undefined
          ? { suggestedRole: dto.suggestedRole?.trim() || null }
          : {}),
        ...(dto.permissions
          ? { permissionIds: await this.resolvePermissionIds(dto.permissions) }
          : {}),
      },
    });
  }

  /**
   * Deleting a template leaves its holders exactly as they are.
   *
   * Their permission rows are their own copies, so nobody loses access — they
   * simply stop being described as "Bursar". The FK clears the link.
   */
  async remove(schoolId: string, templateId: string): Promise<void> {
    const template = await this.ownTemplate(schoolId, templateId);
    await this.prisma.roleTemplate.delete({ where: { id: template.id } });
  }

  /**
   * Push a template's current access back onto the people who hold it.
   *
   * Skips hand-edited holders unless asked, because someone deliberately gave
   * that person an exception and quietly erasing it is worse than doing nothing.
   * Principal-tier holders are skipped outright: their access does not come from
   * rows, so writing rows would say nothing true about them.
   */
  async reapply(
    schoolId: string,
    templateId: string,
    dto: ReapplyRoleTemplateDto,
  ): Promise<{ updated: number; skippedCustomised: number; skippedPrincipals: number }> {
    const template = await this.prisma.roleTemplate.findFirst({
      where: { id: templateId, OR: [{ schoolId }, { schoolId: null }] },
    });
    if (!template) {
      throw new NotFoundException('Role template not found');
    }

    const holders = await this.prisma.schoolAdmin.findMany({
      where: { schoolId, roleTemplateId: template.id },
      select: { id: true, accessTier: true, templateCustomised: true },
    });

    const principals = holders.filter((h) => hasPrincipalAccess(h));
    const eligible = holders.filter(
      (h) => !hasPrincipalAccess(h) && (dto?.includeCustomised || !h.templateCustomised),
    );
    const skippedCustomised = holders.filter(
      (h) => !hasPrincipalAccess(h) && h.templateCustomised && !dto?.includeCustomised,
    ).length;

    for (const holder of eligible) {
      await this.prisma.$transaction(async (tx) => {
        await tx.staffPermission.deleteMany({ where: { adminId: holder.id } });
        if (template.permissionIds.length > 0) {
          await tx.staffPermission.createMany({
            data: template.permissionIds.map((permissionId) => ({
              adminId: holder.id,
              permissionId,
            })),
            skipDuplicates: true,
          });
        }
        await tx.schoolAdmin.update({
          where: { id: holder.id },
          data: { templateCustomised: false },
        });
      });
    }

    this.logger.log(
      `[reapply] template ${template.id}: ${eligible.length} updated, ` +
        `${skippedCustomised} customised skipped, ${principals.length} principals skipped`,
    );

    return {
      updated: eligible.length,
      skippedCustomised,
      skippedPrincipals: principals.length,
    };
  }

  /** The exact rows a template would grant, for the create/demote flows. */
  async permissionIdsForTemplate(schoolId: string, templateId: string): Promise<string[]> {
    const template = await this.prisma.roleTemplate.findFirst({
      where: { id: templateId, OR: [{ schoolId }, { schoolId: null }] },
      select: { permissionIds: true },
    });
    if (!template) {
      throw new BadRequestException('That access template does not exist for this school');
    }
    return template.permissionIds;
  }

  private async ownTemplate(schoolId: string, templateId: string) {
    const template = await this.prisma.roleTemplate.findFirst({
      where: { id: templateId },
    });
    if (!template || (template.schoolId !== schoolId && template.schoolId !== null)) {
      throw new NotFoundException('Role template not found');
    }
    if (template.schoolId === null) {
      throw new BadRequestException(
        'Built-in roles cannot be edited. Create your own version of it instead.',
      );
    }
    return template;
  }

  private async assertNameFree(schoolId: string, name: string): Promise<void> {
    const clash = await this.prisma.roleTemplate.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        OR: [{ schoolId }, { schoolId: null }],
      },
      select: { id: true, schoolId: true },
    });
    if (clash) {
      throw new ConflictException(
        clash.schoolId === null
          ? `"${name}" is a built-in role. Pick a different name.`
          : `You already have a role called "${name}".`,
      );
    }
  }

  private async resolvePermissionIds(
    permissions: Array<{ resource: PermissionResource; type: PermissionType }>,
  ): Promise<string[]> {
    const rows = await this.prisma.permission.findMany({
      where: {
        OR: permissions.map((p) => ({
          resource: p.resource as PermissionResource,
          type: p.type as PermissionType,
        })),
      },
      select: { id: true },
    });

    if (rows.length === 0) {
      throw new BadRequestException('None of those permissions exist');
    }
    return rows.map((row) => row.id);
  }
}
