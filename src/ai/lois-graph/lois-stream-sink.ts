import { Response } from 'express';
import { Logger } from '@nestjs/common';
import { LoisSource } from '../ai-lois-source';

const logger = new Logger('LoisStreamSink');

export type LoisStreamSink = {
  send: (event: string, data: unknown) => void;
  remainingTokens: number;
  abortSignal?: AbortSignal;
  estimatedTokens: number;
  assistantText: string;
  addEstimated: (chars: number) => boolean;
  recordUsage: (usage: unknown) => void;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  toolEvents: unknown[];
  sources: LoisSource[];
};

export function createLoisStreamSink(
  res: Response | null,
  remainingTokens: number,
  abortSignal?: AbortSignal,
): LoisStreamSink {
  const sink: LoisStreamSink = {
    remainingTokens,
    abortSignal,
    estimatedTokens: 0,
    assistantText: '',
    usage: null,
    toolEvents: [],
    sources: [],
    send(event, data) {
      if (event === 'token' && data && typeof data === 'object' && 'token' in data) {
        const piece = String((data as { token?: unknown }).token || '');
        if (piece) sink.assistantText += piece;
      }
      if (!res || res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        logger.debug(`SSE write skipped: ${e}`);
      }
    },
    addEstimated(chars: number) {
      sink.estimatedTokens += Math.ceil(chars / 3.5);
      return sink.estimatedTokens <= sink.remainingTokens;
    },
    recordUsage(usage: unknown) {
      if (usage && typeof usage === 'object') {
        sink.usage = usage as LoisStreamSink['usage'];
      }
    },
  };
  return sink;
}

export function dedupeSources(sources: LoisSource[]): LoisSource[] {
  const seen = new Set<string>();
  const out: LoisSource[] = [];
  for (const s of sources) {
    const key = `${s.kind}:${s.tool || s.type || ''}:${s.label}:${s.href || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 8);
}
