import { Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import { LoisPageContextInput } from './ai-page-context';
import { LoisRuntimeService } from './lois-graph/lois-runtime.service';

/**
 * Thin adapter: Nest SSE entry stays here; the LangGraph runtime owns the loop.
 */
@Injectable()
export class AiChatStreamService {
  private readonly logger = new Logger(AiChatStreamService.name);

  constructor(private readonly loisRuntime: LoisRuntimeService) {}

  async chatStreamSSE(
    res: Response,
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    userId?: string,
    conversationId?: string,
    schoolId?: string,
    remainingTokens: number = Infinity,
    abortSignal?: AbortSignal,
    pageContext?: LoisPageContextInput | null,
  ): Promise<{ total_tokens: number }> {
    this.logger.debug(`chatStreamSSE → LoisRuntime school=${schoolId || ''} conv=${conversationId || 'new'}`);
    return this.loisRuntime.run({
      res,
      messages,
      userId,
      conversationId,
      schoolId,
      remainingTokens,
      abortSignal,
      pageContext,
    });
  }
}
