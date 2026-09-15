import { SchoolSettingsService } from './school-settings.service';

describe('createKnowledgeDocument', () => {
  it('stores searchable policy metadata and queues an embedding job', async () => {
    const created = { id: 'kc_1', schoolId: 'sch_1', content: 'Late coming is 15 minutes.' };
    const prisma = {
      knowledgeChunk: {
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const vectorQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    const service = new SchoolSettingsService(prisma as any, vectorQueue as any);

    const result = await service.createKnowledgeDocument('sch_1', {
      title: 'Late coming',
      content: 'Late coming is 15 minutes.',
      source: 'UPLOAD',
    });

    expect(result).toEqual(created);
    expect(prisma.knowledgeChunk.create).toHaveBeenCalledWith({
      data: {
        schoolId: 'sch_1',
        content: 'Late coming is 15 minutes.',
        metadata: {
          type: 'POLICY',
          title: 'Late coming',
          source: 'UPLOAD',
          permissions: {
            roles: ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'TEACHER', 'STUDENT'],
            isPublic: true,
          },
        },
      },
    });
    expect(vectorQueue.add).toHaveBeenCalledWith(
      'generate-embedding',
      { chunkId: 'kc_1' },
      expect.objectContaining({ removeOnComplete: true }),
    );
  });
});
