import { isDocumentKnowledgeChunk } from './knowledge-chunk-types';

describe('isDocumentKnowledgeChunk', () => {
  it('accepts policy, handbook, and document types', () => {
    expect(isDocumentKnowledgeChunk({ type: 'POLICY', permissions: { isPublic: true } })).toBe(true);
    expect(isDocumentKnowledgeChunk({ type: 'handbook' })).toBe(true);
    expect(isDocumentKnowledgeChunk({ type: 'document' })).toBe(true);
    expect(isDocumentKnowledgeChunk({ source: 'UPLOAD', title: 'Late coming' })).toBe(true);
  });

  it('rejects leftover operational chunks', () => {
    expect(isDocumentKnowledgeChunk({ type: 'grade', studentId: 's1' })).toBe(false);
    expect(isDocumentKnowledgeChunk({ type: 'student_profile' })).toBe(false);
    expect(isDocumentKnowledgeChunk({ type: 'school_info' })).toBe(false);
    expect(isDocumentKnowledgeChunk({ type: 'teacher_info' })).toBe(false);
    expect(isDocumentKnowledgeChunk(null)).toBe(false);
  });
});
