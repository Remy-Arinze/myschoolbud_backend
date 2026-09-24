import { ApiProperty } from '@nestjs/swagger';
import { ClassType } from './create-class.dto';

export class ClassTeacherDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  teacherId: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ required: false })
  email: string | null;

  @ApiProperty({ required: false })
  subject: string | null;

  @ApiProperty()
  isPrimary: boolean;

  @ApiProperty({ required: false, description: 'Secondary form teacher for this class arm' })
  isFormTeacher?: boolean;

  @ApiProperty()
  createdAt: Date;
}

export class ClassDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false })
  code: string | null;

  @ApiProperty({ required: false })
  classLevel: string | null;

  @ApiProperty({ enum: ClassType })
  type: ClassType;

  @ApiProperty()
  academicYear: string;

  @ApiProperty({ required: false })
  creditHours: number | null;

  @ApiProperty({ required: false })
  description: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: [ClassTeacherDto] })
  teachers: ClassTeacherDto[];

  @ApiProperty()
  studentsCount: number;

  @ApiProperty({ required: false, description: 'Only present for ClassArm-based classes' })
  classArmId?: string;

  @ApiProperty({ required: false, description: 'Only present for ClassArm-based classes' })
  classLevelId?: string;
}
