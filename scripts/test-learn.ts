import { learnGraph } from "../lib/modules/learn";
import { resetRouterState } from "../lib/ai/router";

async function main() {
  console.log("Starting Learn Graph test with Gemini Pro...");
  
  // reset router state just in case
  resetRouterState();

  const initialState = {
    topic: "Rate Limiting",
    domain: "Backend",
    difficulty: "intermediate" as const,
    format: "system_design" as const,
    draft: null,
    review: null,
    revisions: 0,
  };

  try {
    const finalState = (await learnGraph.invoke(initialState as any)) as any;
    console.log("\n=== Final Draft ===");
    console.log(JSON.stringify(finalState.draft, null, 2));
    
    console.log("\n=== Review ===");
    console.log(JSON.stringify(finalState.review, null, 2));
    
    console.log(`\nRevisions taken: ${finalState.revisions}`);
  } catch (err) {
    console.error("Graph failed:", err);
  }
}

main().catch(console.error);
