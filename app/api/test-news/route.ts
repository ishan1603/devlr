import { NextRequest, NextResponse } from "next/server";
import { fetchArticles } from "@/lib/news";

/**
 * Debug helper for inspecting what the news layer returns for a set of
 * categories. Gated to development: it is unauthenticated and each call spends
 * NewsAPI quota, so leaving it reachable in production is a free way for anyone
 * to exhaust the daily limit.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const categoriesParam = new URL(request.url).searchParams.get("categories");
    const categories = categoriesParam
      ? categoriesParam.split(",").map((c) => c.trim()).filter(Boolean)
      : ["technology", "business"];

    const articles = await fetchArticles(categories);

    return NextResponse.json({
      totalArticles: articles.length,
      categories,
      byCategory: Object.fromEntries(
        categories.map((c) => [c, articles.filter((a) => a.category === c).length])
      ),
      sample: articles.slice(0, 3),
    });
  } catch (error) {
    console.error("test-news error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
