import { DynamicTool } from '@langchain/core/tools';
import { ForbiddenException } from '@nestjs/common';
import { AiAgentToolsService } from '../ai-agent-tools.service';
import { AgentToolContext, LoisSource } from '../ai-lois-source';
import { toLoisStreamErrorPayload } from '../ai-stream-errors';
import type { AgoraToolDef } from '../lois-workers';
import type { LoisStreamSink } from './lois-stream-sink';
import { toClientFacingToolArgs, toClientFacingToolData, toModelFacingToolData } from '../lois-plan-facing';
import { toolEntityLabel } from './lois-tool-entity';

export type WrappedToolResult = {
  data: unknown;
  modelData: unknown;
  sources?: LoisSource[];
};

/**
 * LangChain wrappers around existing Nest tool execution.
 * Workers still call OpenAI with the original JSON-schema tools; these wrappers
 * are the single execute path (permissions stay in assertLoisToolAllowed).
 */
export function wrapAgoraTools(
  defs: AgoraToolDef[],
  agentTools: AiAgentToolsService,
  sink: LoisStreamSink,
  context: AgentToolContext,
): DynamicTool[] {
  return defs.map(
    (def) =>
      new DynamicTool({
        name: def.function.name,
        description: def.function.description,
        func: async (input: string) => {
          let args: Record<string, unknown> = {};
          try {
            args = input ? (JSON.parse(input) as Record<string, unknown>) : {};
          } catch {
            args = { input };
          }
          const result = await executeWrappedTool(
            def.function.name,
            args,
            agentTools,
            sink,
            context,
          );
          return JSON.stringify(result.modelData);
        },
      }),
  );
}

export async function executeWrappedTool(
  functionName: string,
  functionArgs: Record<string, unknown>,
  agentTools: AiAgentToolsService,
  sink: LoisStreamSink,
  context: AgentToolContext,
  toolCallId?: string,
): Promise<WrappedToolResult> {
  const thinkingEvent = { message: agentTools.getToolThinkingMessage(functionName) };
  sink.send('thinking', thinkingEvent);
  sink.toolEvents.push({ type: 'thinking', ...thinkingEvent });

  const startLabel = toolEntityLabel(functionName, functionArgs);
  const clientArgs = toClientFacingToolArgs(functionArgs);
  const toolStartEvent = {
    toolCallId,
    toolName: functionName,
    toolDisplayName: agentTools.getToolDisplayName(functionName),
    entityLabel: startLabel,
    args: clientArgs,
  };
  sink.send('tool_start', toolStartEvent);
  sink.toolEvents.push({ type: 'tool_start', ...toolStartEvent });

  let data: unknown;
  let sources: LoisSource[] | undefined;
  try {
    const result = await agentTools.executeAgentTool(functionName, functionArgs, context);
    data = result.data;
    if (result.sources?.length) {
      sources = result.sources;
      sink.sources.push(...result.sources);
    }
  } catch (tErr: unknown) {
    if (tErr instanceof ForbiddenException) {
      const p = toLoisStreamErrorPayload(tErr);
      data = { error: p.message, code: p.code };
    } else {
      const anyErr = tErr as { message?: string };
      data = { error: anyErr?.message || 'Something went wrong running that action.' };
    }
  }

  const resultLabel = toolEntityLabel(functionName, functionArgs, data) || startLabel;
  const toolResultEvent = {
    toolCallId,
    toolName: functionName,
    toolDisplayName: agentTools.getToolDisplayName(functionName),
    entityLabel: resultLabel,
    args: clientArgs,
    result: toClientFacingToolData(data),
  };
  sink.send('tool_result', toolResultEvent);
  const startIdx = sink.toolEvents.findIndex(
    (e: { type?: string; toolCallId?: string; toolName?: string }) =>
      e.type === 'tool_start' &&
      (toolCallId ? e.toolCallId === toolCallId : e.toolName === functionName),
  );
  if (startIdx >= 0) {
    sink.toolEvents[startIdx] = { type: 'tool_result', ...toolResultEvent };
  } else {
    sink.toolEvents.push({ type: 'tool_result', ...toolResultEvent });
  }

  return { data, modelData: toModelFacingToolData(functionName, data), sources };
}

export function planFromToolResult(
  functionName: string,
  data: unknown,
): { planId: string; planKind: 'TIMETABLE' | 'SCHEME' } | null {
  if (functionName !== 'propose_timetable' && functionName !== 'propose_scheme') return null;
  if (!data || typeof data !== 'object') return null;
  const rec = data as { planId?: string; kind?: string; error?: string };
  if (rec.error || !rec.planId) return null;
  const planKind = rec.kind === 'SCHEME' || functionName === 'propose_scheme' ? 'SCHEME' : 'TIMETABLE';
  return { planId: rec.planId, planKind };
}

export function truncateToolPayload(json: string, max = 8000): string {
  if (json.length <= max) return json;
  return `${json.slice(0, max)}\n…[truncated]`;
}
