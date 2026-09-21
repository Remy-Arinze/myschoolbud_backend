export type AgentToolContext = {
  schoolId?: string;
  userRole?: string;
  userId?: string;
  conversationId?: string | null;
  /** Latest user utterance — used to pin relative calendar windows. */
  userMessage?: string | null;
  /** When set, Lois queries stay on this school type (Primary / Secondary / Tertiary). */
  schoolType?: string | null;
  /** Display title only. Never branch on this — see `adminAccessTier`. */
  adminRole?: string | null;
  /** Authority: 'PRINCIPAL' bypasses the permission tables. */
  adminAccessTier?: string | null;
  adminId?: string | null;
};

/** Grounding chips attached to Lois tool / RAG results. */

export type LoisSource = {
  kind: 'tool' | 'rag';
  tool?: string;
  type?: string;
  label: string;
  href?: string;
  relevance?: number;
};

export type AgentToolResult = {
  data: any;
  usage: any;
  sources?: LoisSource[];
};

export function toolSource(
  tool: string,
  label: string,
  href?: string,
): LoisSource {
  return { kind: 'tool', tool, label, href };
}
