import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { LiveStatusModule } from '../live-status/live-status.module';

// Super Admin
import { SuperAdminSchoolsController } from './super-admin/super-admin-schools.controller';
import { SuperAdminSchoolsService } from './super-admin/super-admin-schools.service';

// School Admin
import { SchoolAdminSchoolsController } from './school-admin/school-admin-schools.controller';
import { SchoolAdminSchoolsService } from './school-admin/school-admin-schools.service';

// Public Registration
import { SchoolRegistrationController } from './public/school-registration.controller';
import { SchoolRegistrationService } from './public/school-registration.service';

// Staff
import { StaffController } from './staff/staff.controller';
import { AdminService } from './staff/admins/admin.service';
import { TeacherService } from './staff/teachers/teacher.service';
import { TeacherSubjectsService } from './staff/teachers/teacher-subjects.service';
import { TeacherController } from './staff/teachers/teacher.controller';
import { TeacherCurrentSchoolService } from './staff/teachers/teacher-current-school.service';
import { PermissionService } from './staff/permissions/permission.service';
import { RoleTemplateService } from './staff/permissions/role-template.service';
import { StaffImportService } from './staff/staff-import.service';

// Classes
import { ClassController } from './classes/class.controller';
import { ClassService } from './classes/class.service';
import { ClassResourceController } from './classes/class-resource.controller';
import { ClassResourceService } from './classes/class-resource.service';

// Faculties & Departments (Tertiary)
import {
  FacultyController,
  DepartmentController,
  LevelController,
} from './faculties/faculty.controller';
import { FacultyService } from './faculties/faculty.service';

// Curriculum
import { CurriculumModule } from './curriculum/curriculum.module';
import { SchemeOfWorkModule } from './scheme-of-work/scheme-of-work.module';

// Repositories
import { SchoolRepository } from './domain/repositories/school.repository';
import { StaffRepository } from './domain/repositories/staff.repository';
import { SchoolScopedRepository } from './domain/repositories/school-scoped.repository';

// Mappers
import { SchoolMapper } from './domain/mappers/school.mapper';
import { StaffMapper } from './domain/mappers/staff.mapper';

// Shared Services
import { IdGeneratorService } from './shared/id-generator.service';
import { SchoolValidatorService } from './shared/school-validator.service';
import { StaffValidatorService } from './shared/staff-validator.service';
import { CloudinaryModule } from '../storage/cloudinary/cloudinary.module';
import { NotificationModule } from '../notification/notification.module';
import { SchoolSettingsModule } from '../school-settings/school-settings.module';
import { PortalsModule } from '../portals/portals.module';
import { SchoolLifecycleModule } from './lifecycle/school-lifecycle.module';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => AuthModule),
    EmailModule,
    forwardRef(() => CurriculumModule),
    SchemeOfWorkModule,
    CloudinaryModule,
    SubscriptionsModule,
    LiveStatusModule,
    NotificationModule,
    SchoolSettingsModule,
    PortalsModule,
    SchoolLifecycleModule,
  ],
  controllers: [
    // New architecture controllers
    SuperAdminSchoolsController,
    SchoolAdminSchoolsController,
    SchoolRegistrationController,
    StaffController,
    TeacherController,
    ClassController,
    ClassResourceController,
    FacultyController,
    DepartmentController,
    LevelController,
  ],
  providers: [
    // New architecture services
    SuperAdminSchoolsService,
    SchoolAdminSchoolsService,
    SchoolRegistrationService,
    AdminService,
    TeacherService,
    TeacherSubjectsService,
    TeacherCurrentSchoolService,
    PermissionService,
    RoleTemplateService,
    StaffImportService,
    ClassService,
    ClassResourceService,
    FacultyService,
    // Repositories
    SchoolRepository,
    StaffRepository,
    SchoolScopedRepository,
    // Mappers
    SchoolMapper,
    StaffMapper,
    // Shared services
    IdGeneratorService,
    SchoolValidatorService,
    StaffValidatorService,
  ],
  exports: [
    SuperAdminSchoolsService,
    SchoolAdminSchoolsService,
    AdminService,
    TeacherService,
    TeacherSubjectsService,
    ClassService,
    ClassResourceService,
    FacultyService,
    SchoolRepository,
    StaffRepository,
    SchoolScopedRepository,
    SchoolMapper,
    StaffMapper,
    IdGeneratorService,
    SchoolValidatorService,
    StaffValidatorService,
    SchoolLifecycleModule,
  ],
})
export class SchoolsModule { }
