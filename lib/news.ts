// Add delay between API calls to avoid rate limiting
async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import { getEnhancedFallbackNews } from './fallback-news';

export interface Article {
  title: string;
  url: string;
  description: string;
  category: string;
  source?: string;
  publishedAt?: string;
}

/**
 * Single mapping point for NewsAPI payloads.
 *
 * There are three fetch paths here (targeted query, top-headlines fallback,
 * simplified query) and each used to build its own object literal, so
 * `publishedAt` and `source` were dropped on all of them and the shapes were
 * free to drift apart.
 */
function toArticle(raw: any, category: string): Article {
  return {
    title: raw.title,
    url: raw.url,
    description: raw.description || "No description available",
    category,
    source: raw.source?.name ?? undefined,
    publishedAt: raw.publishedAt ?? undefined,
  };
}

export async function fetchArticles(categories: string[]): Promise<Article[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Process categories sequentially with delays to avoid rate limiting
  const allArticles: Article[] = [];
  
  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    
    try {
      // Add delay between requests (except for the first one)
      if (i > 0) {
        await delay(2000); // 2 second delay between requests to be safer
      }
      // Use more specific search terms and sources for better results
      const searchQuery =
        category === "science"
          ? "science research breakthrough discovery innovation medical space climate AI technology -entertainment -sports -gaming"
          : category === "sports"
            ? "sports NFL NBA MLB soccer olympics championship tournament -entertainment -movies -gaming"
            : category === "technology"
              ? "technology software hardware AI startup cybersecurity innovation -entertainment -movies -gaming -betting"
              : category === "politics"
                ? "politics government election policy legislation democracy congress senate -entertainment -sports -gaming"
                : category === "environment"
                  ? "environment climate change sustainability renewable energy conservation pollution -entertainment -sports -gaming"
                  : category === "health"
                    ? "health medical healthcare medicine disease treatment wellness -entertainment -sports -gaming"
                    : category === "entertainment"
                      ? "entertainment movies music celebrities hollywood streaming -sports -politics -technology"
                      : category === "business"
                        ? "business finance economy markets stocks corporate earnings -entertainment -sports -gaming"
                        : category;

      console.log(
        `Fetching articles for category: ${category} with query: ${searchQuery}`
      );

      const response = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(
          searchQuery
        )}&from=${since}&sortBy=publishedAt&language=en&domains=techcrunch.com,arstechnica.com,reuters.com,bbc.com,cnn.com,espn.com,sciencedaily.com,nature.com,politico.com,washingtonpost.com,theguardian.com,businessinsider.com,variety.com,deadline.com,healthline.com,webmd.com&apiKey=${process.env.NEWS_API_KEY}`,
        {
          headers: {
            'User-Agent': 'Sendlr-AI/1.0 (Newsletter Application)',
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        console.error(
          `Failed fetching for category: ${category}`,
          response.status,
          response.statusText
        );

        // Handle rate limiting specifically
        if (response.status === 429) {
          console.log(`Rate limited for ${category}. Using enhanced fallback content.`);
          // Get enhanced fallback content for this category
          const fallbackArticles = getEnhancedFallbackNews([category]);
          allArticles.push(...fallbackArticles);
          continue; // Skip API calls for this category
        }

        // Try with a simpler approach using top-headlines
        console.log(`Trying fallback approach for category: ${category}`);
        const fallbackCategory =
          category === "science"
            ? "science"
            : category === "sports"
              ? "sports"
              : category === "technology"
                ? "technology"
                : category === "politics"
                  ? "general" // Politics often falls under general news
                  : category === "environment"
                    ? "science" // Environment news often categorized under science
                    : category === "health"
                      ? "health"
                      : category === "entertainment"
                        ? "entertainment"
                        : category === "business"
                          ? "business"
                          : "general"; // Default fallback
        const fallbackResponse = await fetch(
          `https://newsapi.org/v2/top-headlines?category=${fallbackCategory}&language=en&country=us&apiKey=${process.env.NEWS_API_KEY}`,
          {
            headers: {
              'User-Agent': 'Sendlr-AI/1.0 (Newsletter Application)',
              'Accept': 'application/json',
            },
          }
        );

        if (fallbackResponse.ok) {
          const fallbackData = await fallbackResponse.json();
          console.log(
            `Fallback found ${fallbackData.articles?.length || 0} articles for ${category}`
          );
          const fallbackArticles = fallbackData.articles
            .slice(0, 5)
            .map((a: any) => toArticle(a, category));
          allArticles.push(...fallbackArticles);
          continue; // Move to next category
        } else {
          console.error(
            `Fallback also failed for ${category}:`,
            fallbackResponse.status,
            fallbackResponse.statusText
          );
        }

        continue; // Skip this category and move to next
      }

      const data = await response.json();
      console.log(
        `Raw API response for ${category}:`,
        data.articles?.length || 0,
        "articles"
      );

      if (!data.articles || data.articles.length === 0) {
        console.log(
          `No articles returned for ${category}, trying simpler query`
        );

        // Try with just the category name if complex query fails
        const simpleQuery = category;
        const simpleResponse = await fetch(
          `https://newsapi.org/v2/everything?q=${encodeURIComponent(
            simpleQuery
          )}&from=${since}&sortBy=publishedAt&language=en&apiKey=${process.env.NEWS_API_KEY}`,
          {
            headers: {
              'User-Agent': 'Sendlr-AI/1.0 (Newsletter Application)',
              'Accept': 'application/json',
            },
          }
        );

        if (simpleResponse.ok) {
          const simpleData = await simpleResponse.json();
          console.log(
            `Simple query found ${simpleData.articles?.length || 0} articles for ${category}`
          );

          if (simpleData.articles && simpleData.articles.length > 0) {
            const simpleArticles = simpleData.articles
              .slice(0, 5)
              .map((a: any) => toArticle(a, category));
            allArticles.push(...simpleArticles);
            continue; // Move to next category
          }
        }
      }

      // Filter out articles with missing content but be less restrictive
      const filteredArticles = data.articles
        .filter(
          (article: any) =>
            article.title &&
            article.description &&
            article.url &&
            article.title.length > 5 &&
            article.description.length > 10 &&
            !article.title.includes("[Removed]") &&
            !article.description.includes("[Removed]") &&
            // Exclude obviously irrelevant content
            !article.title.toLowerCase().includes("betting") &&
            !article.title.toLowerCase().includes("casino") &&
            !article.title.toLowerCase().includes("porn")
        )
        .slice(0, 5) // Take 5 per category for better content
        .map((a: any) => toArticle(a, category));

      console.log(
        `Filtered to ${filteredArticles.length} articles for ${category}`
      );
      allArticles.push(...filteredArticles);
    } catch (error) {
      console.error(`Error fetching ${category}:`, error);
      
      // Use enhanced fallback content instead of simple mock articles
      const fallbackArticles = getEnhancedFallbackNews([category]);
      allArticles.push(...fallbackArticles);
    }
  }

  console.log(`Total articles fetched: ${allArticles.length}`);
  console.log(
    `Articles by category:`,
    categories
      .map(
        (cat) =>
          `${cat}: ${allArticles.filter((a) => a.category === cat).length}`
      )
      .join(", ")
  );

  return allArticles;
}
