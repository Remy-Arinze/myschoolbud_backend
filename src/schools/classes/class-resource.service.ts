import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { SchoolRepository } from '../domain/repositories/school.repository';
import { ClassResourceDto, CreateClassResourceDto } from '../dto/class-resource.dto';
import { CloudinaryService } from '../../storage/cloudinary/cloudinary.service';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { safeResolvePath } from '../../common/utils/path-traversal';
import { NotificationService } from '../../notification/notification.service';
import { NotificationInboxService } from '../../notification/notification-inbox.service';
import { plainFileLabel } from '../../notification/notification-text';

@Injectable()
export class ClassResourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolRepository: SchoolRepository,
    private readonly cloudinaryService: CloudinaryService,
    private readonly notificationService: NotificationService,
    private readonly notificationInbox: NotificationInboxService,
  ) { }

  private get classModel() {
    return (this.prisma as any)['class'];
  }

  private get classResourceModel() {
    return (this.prisma as any)['classResource'];
  }

  /**
   * Upload a resource to a class
   */
  async uploadResource(
    schoolId: string,
    classId: string,
    file: Express.Multer.File,
    userId: string,
    dto?: CreateClassResourceDto
  ): Promise<ClassResourceDto> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
      },
    });

    let targetClassId: string | null = null;
    let targetClassArmId: string | null = null;
    let resourceFolder: string;

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm
      targetClassArmId = classArm.id;
      resourceFolder = `schools/${school.id}/class-arms/${classArm.id}/resources`;
    } else {
      // It's a Class - validate it exists
      const classData = await this.classModel.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }

      targetClassId = classData.id;
      resourceFolder = `schools/${school.id}/classes/${classId}/resources`;
    }

    // Validate file
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate file type and size
    this.validateFile(file);

    // Determine file type
    const fileType = this.getFileType(file.mimetype);

    // Generate unique filename
    const fileExtension = path.extname(file.originalname);
    const uniqueFileName = `${uuidv4()}${fileExtension}`;

    // Upload to Cloudinary
    const publicId = `resource-${uuidv4()}`;

    const { url: fileUrl, publicId: cloudinaryPublicId } =
      await this.cloudinaryService.uploadRawFile(file, resourceFolder, publicId);

    // Create resource record
    const resource = await this.classResourceModel.create({
      data: {
        name: file.originalname,
        fileName: uniqueFileName,
        filePath: fileUrl, // Store Cloudinary URL in filePath for backward compatibility
        fileSize: file.size,
        mimeType: file.mimetype,
        fileType: fileType,
        description: dto?.description || null,
        classId: targetClassId,
        classArmId: targetClassArmId,
        uploadedBy: userId,
      },
      include: {
        class: true,
      },
    });

    try {
      const studentUserIds = await this.notificationInbox.getStudentUserIdsInClass({
        schoolId: school.id,
        classId: targetClassId || undefined,
        classArmId: targetClassArmId || undefined,
      });
      void this.notificationService.notifyUsers(studentUserIds, {
        schoolId: school.id,
        role: 'STUDENT',
        type: 'RESOURCE_UPLOADED',
        title: 'New resource',
        subtitle: plainFileLabel(file.originalname),
        body: `${plainFileLabel(file.originalname)} was added to your class resources.`,
        link: '/dashboard/student/resources',
        metadata: { resourceId: resource.id, classId: targetClassId, classArmId: targetClassArmId },
      });
    } catch {
      // Uploads must succeed even when notification delivery fails.
    }

    return this.mapToDto(resource);
  }

  /**
   * Get all resources for a class or ClassArm
   * For PRIMARY/SECONDARY: If classId is ClassArm, get ClassArm resources + ClassLevel shared resources
   * For TERTIARY: Get Class resources (backward compatibility)
   */
  async getClassResources(schoolId: string, classId: string): Promise<ClassResourceDto[]> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Check if classId is a ClassArm (for PRIMARY/SECONDARY schools using ClassArms)
    const classArm = await (this.prisma as any).classArm.findUnique({
      where: { id: classId },
      include: {
        classLevel: true,
      },
    });

    let whereClause: any;

    if (classArm && classArm.classLevel.schoolId === school.id) {
      // It's a ClassArm - get ClassArm-specific resources + ClassLevel shared resources
      whereClause = {
        OR: [
          { classArmId: classArm.id },
          // Could also include ClassLevel resources if shared (would need classLevelId in ClassResource)
        ],
      };
    } else {
      // It's a Class - validate it exists
      const classData = await this.classModel.findFirst({
        where: {
          id: classId,
          schoolId: school.id,
        },
      });

      if (!classData) {
        throw new NotFoundException('Class or ClassArm not found');
      }

      whereClause = {
        classId: classId,
        classArmId: null, // Only Class resources, not ClassArm-specific
      };
    }

    // Get resources with uploader information
    const resources = await this.classResourceModel.findMany({
      where: whereClause,
      orderBy: {
        createdAt: 'desc',
      },
    });

    const uploaderNames = await this.getUploaderNames(
      resources.map((resource: any) => resource.uploadedBy).filter(Boolean),
    );

    return resources.map((resource: any) =>
      this.mapToDto({
        ...resource,
        uploadedByName: uploaderNames.get(resource.uploadedBy) || 'Unknown',
      }),
    );
  }

  /**
   * Get a single resource
   */
  async getResource(
    schoolId: string,
    classId: string,
    resourceId: string
  ): Promise<ClassResourceDto> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate class exists and belongs to school
    const classData = await this.classModel.findFirst({
      where: {
        id: classId,
        schoolId: school.id,
      },
    });

    if (!classData) {
      throw new NotFoundException('Class not found');
    }

    // Get resource
    const resource = await this.classResourceModel.findFirst({
      where: {
        id: resourceId,
        classId: classId,
      },
    });

    if (!resource) {
      throw new NotFoundException('Resource not found');
    }

    // Get uploader name
    const uploaderName = await this.getUploaderName(resource.uploadedBy);
    const resourceWithUploader = {
      ...resource,
      uploadedByName: uploaderName,
    };

    return this.mapToDto(resourceWithUploader);
  }

  /**
   * Delete a resource
   */
  async deleteResource(schoolId: string, classId: string, resourceId: string): Promise<void> {
    // Validate school exists
    const school = await this.schoolRepository.findById(schoolId);
    if (!school) {
      throw new BadRequestException('School not found');
    }

    // Validate class exists and belongs to school
    const classData = await this.classModel.findFirst({
      where: {
        id: classId,
        schoolId: school.id,
      },
    });

    if (!classData) {
      throw new NotFoundException('Class not found');
    }

    // Get resource
    const resource = await this.classResourceModel.findFirst({
      where: {
        id: resourceId,
        classId: classId,
      },
    });

    if (!resource) {
      throw new NotFoundException('Resource not found');
    }

    // Delete file from Cloudinary or local storage
    if (resource.filePath) {
      const isCloudinaryUrl =
        resource.filePath.startsWith('http://') || resource.filePath.startsWith('https://');

      if (isCloudinaryUrl) {
        // Delete from Cloudinary
        const publicId = this.cloudinaryService.extractPublicId(resource.filePath);
        if (publicId) {
          try {
            await this.cloudinaryService.deleteRawFile(publicId);
          } catch (error) {
            console.error('Error deleting file from Cloudinary:', error);
            // Continue with database deletion even if Cloudinary deletion fails
          }
        }
      } else {
        // Backward compatibility: Delete from local filesystem for old resources
        if (fs.existsSync(resource.filePath)) {
          try {
            fs.unlinkSync(resource.filePath);
          } catch (error) {
            console.error('Error deleting file from local storage:', error);
            // Continue with database deletion even if file deletion fails
          }
        }
      }
    }

    // Delete resource record
    await this.classResourceModel.delete({
      where: {
        id: resourceId,
      },
    });
  }

  /**
   * Get file buffer for download (fetches from Cloudinary or local storage for backward compatibility)
   */
  async getFileBuffer(
    schoolId: string,
    classId: string,
    resourceId: string
  ): Promise<{ buffer: Buffer; resource: ClassResourceDto }> {
    const resource = await this.getResource(schoolId, classId, resourceId);

    if (!resource.filePath) {
      throw new NotFoundException('File URL not found');
    }

    // Check if filePath is a Cloudinary URL (starts with http/https and contains cloudinary.com)
    const isCloudinaryUrl =
      resource.filePath.startsWith('http://') || resource.filePath.startsWith('https://');

    if (isCloudinaryUrl) {
      // Fetch file from Cloudinary URL
      try {
        const response = await fetch(resource.filePath);
        if (!response.ok) {
          throw new NotFoundException('File not found on Cloudinary');
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return { buffer, resource };
      } catch (error) {
        console.error('Error fetching file from Cloudinary:', error);
        throw new NotFoundException('Failed to fetch file from Cloudinary');
      }
    } else {
      // Backward compatibility: Read from local filesystem for old resources
      if (!fs.existsSync(resource.filePath)) {
        throw new NotFoundException('File not found on disk');
      }

      // Prevent path traversal for local legacy files
      const safePath = safeResolvePath(process.cwd(), resource.filePath);
      const buffer = fs.readFileSync(safePath);
      return { buffer, resource };
    }
  }

  /**
   * Validate file type and size
   */
  private validateFile(file: Express.Multer.File): void {
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds maximum limit of 50MB');
    }

    // Only allow documents and spreadsheets, no images
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `File type ${file.mimetype} is not allowed. Only documents and spreadsheets are permitted (PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, CSV). Images are not allowed.`
      );
    }
  }

  /**
   * Determine file type from MIME type
   */
  private getFileType(mimeType: string): string {
    if (mimeType.startsWith('image/')) {
      return 'IMAGE';
    } else if (mimeType === 'application/pdf') {
      return 'PDF';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      return 'DOCX';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      return 'XLSX';
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint'
    ) {
      return 'PPTX';
    } else {
      return 'OTHER';
    }
  }

  /**
   * Resolve uploader display names in bulk (admin → teacher → user email).
   */
  private async getUploaderNames(userIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueIds.length === 0) return names;

    const [admins, teachers, users] = await Promise.all([
      this.prisma.schoolAdmin.findMany({
        where: { userId: { in: uniqueIds } },
        select: { userId: true, firstName: true, lastName: true },
      }),
      this.prisma.teacher.findMany({
        where: { userId: { in: uniqueIds } },
        select: { userId: true, firstName: true, lastName: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, email: true },
      }),
    ]);

    for (const user of users) {
      names.set(user.id, user.email || 'Unknown');
    }
    for (const teacher of teachers) {
      const name = `${teacher.firstName} ${teacher.lastName}`.trim();
      if (name) names.set(teacher.userId, name);
    }
    for (const admin of admins) {
      const name = `${admin.firstName} ${admin.lastName}`.trim();
      if (name) names.set(admin.userId, name);
    }

    return names;
  }

  /**
   * Get uploader name from userId
   */
  private async getUploaderName(userId: string): Promise<string> {
    const names = await this.getUploaderNames([userId]);
    return names.get(userId) || 'Unknown';
  }

  /**
   * Map Prisma resource to DTO
   */
  private mapToDto(resource: any): ClassResourceDto {
    return {
      id: resource.id,
      name: resource.name,
      fileName: resource.fileName,
      filePath: resource.filePath, // This now contains Cloudinary URL
      fileSize: resource.fileSize,
      mimeType: resource.mimeType,
      fileType: resource.fileType,
      description: resource.description,
      classId: resource.classId,
      uploadedBy: resource.uploadedBy,
      uploadedByName: resource.uploadedByName,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
      downloadUrl: resource.filePath, // Cloudinary URL for direct download
    };
  }
}
