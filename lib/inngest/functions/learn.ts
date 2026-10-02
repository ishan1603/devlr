import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase-admin";
import { learnGraph } from "@/lib/modules/learn";

/**
 * Learn: Generates new questions for topics that need them.
 * Runs once a day to maintain a buffer of questions.
 */
export const generateLearnQuestions = inngest.createFunction(
  {
    id: "learn-generate",
    triggers: [{ cron: "0 2 * * *" }], // Every day at 2 AM
    concurrency: { limit: 1 },
    retries: 1,
  },
  async ({ step }) => {
    const supabase = createAdminClient();

    // 1. Get topics that need more questions
    const topics = await step.run("fetch-topics", async () => {
      const { data } = await supabase.from("learn_topics").select("*").limit(5);
      return data || [];
    });

    let generated = 0;

    for (const topic of topics) {
      const item = await step.run(`generate-question-${topic.id}`, async () => {
        try {
          const finalState = await learnGraph.invoke({
            topic: topic.title,
            domain: topic.domain,
            difficulty: topic.difficulty as any,
            format: topic.format as any,
            draft: null,
            review: null,
            revisions: 0,
          } as any) as any;

          if (finalState.review?.pass && finalState.draft) {
            // Save to DB
            const { error } = await supabase.from("learn_items").insert({
              topic_id: topic.id,
              question: finalState.draft.question,
              constraints: finalState.draft.constraints,
              hints: finalState.draft.hints,
              answer_md: finalState.draft.answer_md,
              diagram_ascii: finalState.draft.diagram_ascii || null,
              diagram_mermaid: finalState.draft.diagram_mermaid || null,
              references: finalState.draft.references,
              review_score: finalState.review.score,
              review_feedback: finalState.review.feedback,
              status: "approved",
              model: "gemini:pro", // Or the router's reported model
            });
            if (error) throw error;
            return true;
          }
        } catch (err) {
          console.error(`[learn] Failed to generate for topic ${topic.title}:`, err);
        }
        return false;
      });

      if (item) generated++;
    }

    return { topicsChecked: topics.length, generated };
  }
);
