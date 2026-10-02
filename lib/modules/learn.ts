import { z } from "zod";
import { StateGraph, END } from "@langchain/langgraph";
import { completeJSON } from "@/lib/ai/router";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AuthorOutput = z.object({
  question: z.string().describe("The text of the problem or question."),
  constraints: z.array(z.string()).describe("Specific constraints the user must follow."),
  hints: z.array(z.string()).min(1).describe("3 progressively more helpful hints."),
  answer_md: z.string().describe("The detailed, worked answer in Markdown format."),
  diagram_ascii: z.string().optional().describe("An ASCII diagram illustrating the answer, if applicable."),
  diagram_mermaid: z.string().optional().describe("A Mermaid.js diagram illustrating the answer, if applicable."),
  references: z.array(z.string()).describe("Links to real-world reading or docs."),
});
export type AuthorOutput = z.infer<typeof AuthorOutput>;

export const ReviewerOutput = z.object({
  score: z.number().min(0).max(100).describe("0-100 score based on the rubric."),
  feedback: z.string().describe("Critique of the generated question and answer."),
  pass: z.boolean().describe("True if score is >= 80 and no major issues."),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface LearnGraphState {
  topic: string;
  domain: string;
  difficulty: "beginner" | "intermediate" | "advanced" | "expert";
  format: "system_design" | "concept" | "bug_spotting" | "trade_off" | "interview";
  
  draft: AuthorOutput | null;
  review: ReviewerOutput | null;
  revisions: number;
}

const graphState = {
  topic: { value: (a: string, b: string) => b, default: () => "" },
  domain: { value: (a: string, b: string) => b, default: () => "" },
  difficulty: { value: (a: string, b: string) => b, default: () => "intermediate" as const },
  format: { value: (a: string, b: string) => b, default: () => "system_design" as const },
  draft: { value: (a: AuthorOutput | null, b: AuthorOutput | null) => b ?? a, default: () => null },
  review: { value: (a: ReviewerOutput | null, b: ReviewerOutput | null) => b ?? a, default: () => null },
  revisions: { value: (a: number, b: number) => a + b, default: () => 0 },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

async function authorNode(state: LearnGraphState): Promise<Partial<LearnGraphState>> {
  const prompt = `Write a ${state.difficulty} ${state.format} question about ${state.topic} for a ${state.domain} developer.
  
Previous feedback to address:
${state.review?.feedback ?? "None."}

Current draft to improve:
${state.draft ? JSON.stringify(state.draft, null, 2) : "None."}
`;

  const system = `You are a senior technical interviewer and educator.
Write a challenging, realistic question. The answer must be correct and complete, stating trade-offs.
No invented numbers or fictional APIs. Use Mermaid for architecture diagrams if applicable.`;

  const result = await completeJSON({
    task: "author",
    system,
    prompt,
    schema: AuthorOutput,
    cache: state.revisions === 0, // only cache the first attempt
  });

  if (!result) throw new Error("Author failed to produce a draft.");

  return { draft: result.data, revisions: 1 };
}

async function reviewerNode(state: LearnGraphState): Promise<Partial<LearnGraphState>> {
  if (!state.draft) throw new Error("No draft to review.");

  const prompt = `Topic: ${state.topic} (${state.difficulty} ${state.format})
  
Draft to review:
${JSON.stringify(state.draft, null, 2)}
`;

  const system = `You are a strict technical reviewer. Score the provided learning material from 0-100 on:
1. Correctness (no hallucinated facts or APIs).
2. Completeness (trade-offs stated).
3. Appropriateness for the stated difficulty level.
4. Clarity of the question and hints.

Provide constructive feedback and a boolean 'pass' if score >= 80.`;

  const result = await completeJSON({
    task: "reviewer",
    system,
    prompt,
    schema: ReviewerOutput,
    cache: false,
  });

  if (!result) throw new Error("Reviewer failed to critique the draft.");

  return { review: result.data };
}

function shouldRevise(state: LearnGraphState) {
  if (state.review?.pass || state.revisions >= 3) {
    return END;
  }
  return "author";
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const learnGraph = new StateGraph<LearnGraphState>({ channels: graphState })
  .addNode("author", authorNode)
  .addNode("reviewer", reviewerNode)
  .addEdge("author", "reviewer")
  .addConditionalEdges("reviewer", shouldRevise)
  .setEntryPoint("author")
  .compile();

// ---------------------------------------------------------------------------
// Composer (Email Delivery)
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/supabase-admin";
import type { ComposeProfile } from "@/lib/delivery/compose";
import type { LearnSection, ModuleResult } from "@/lib/delivery/issue";

export async function assembleLearn(profile: ComposeProfile): Promise<ModuleResult> {
  const supabase = createAdminClient();

  // Pick an unseen question that matches the user's domains/stack.
  // Real implementation would filter by difficulty and domain, but for now we
  // just pick an unused, approved question.
  const { data: item } = await supabase
    .from("learn_items")
    .select(`
      id, question, hints, status,
      topic:learn_topics!inner(title)
    `)
    .eq("status", "approved")
    // Ensure we don't pick one they've already received
    .not("id", "in", `(${
      (await supabase.from("learn_progress").select("item_id").eq("user_id", profile.user_id)).data?.map(d => d.item_id).join(",") || "0"
    })`)
    .limit(1)
    .maybeSingle();

  if (!item) {
    return { sections: [], seen: [] };
  }

  // Record that we are sending this to the user today
  await supabase.from("learn_progress").insert({
    user_id: profile.user_id,
    item_id: item.id,
    sent_at: new Date().toISOString(),
  });

  const section: LearnSection = {
    type: "learn",
    module: "learn",
    label: "learn",
    title: item.topic?.title || "Daily Question",
    id: item.id,
    question: item.question,
    hints: item.hints as string[],
    url: `${process.env.NEXT_PUBLIC_APP_URL}/learn/${item.id}`,
  };

  return {
    sections: [section],
    seen: [{ module: "learn", itemType: "question", ref: item.id.toString() }],
  };
}
