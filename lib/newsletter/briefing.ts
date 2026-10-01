import Groq from "groq-sdk";
import type { PoolArticle } from "@/lib/newsletter/pool";

const MODEL = "openai/gpt-oss-20b";

export interface Briefing {
  /** One or two sentences framing the issue. */
  intro: string;
  /** url -> one-sentence take on that story. */
  blurbs: Record<string, string>;
  /** False when Groq was unavailable and descriptions were used instead. */
  aiGenerated: boolean;
}

/**
 * Ask for structured JSON rather than HTML.
 *
 * The previous prompt asked the model to emit markup, which meant the email's
 * layout was only ever as reliable as the model's formatting that day — a
 * stray heading or an unclosed tag reached the reader directly. Returning data
 * and rendering it ourselves makes the template deterministic, and lets the
 * same content drive a web archive or a Slack message later.
 */
export async function generateBriefing(
  articles: PoolArticle[],
  categories: string[]
): Promise<Briefing> {
  const fallback = (): Briefing => ({
    intro: `${articles.length} ${articles.length === 1 ? "story" : "stories"} across ${categories.join(", ")}.`,
    blurbs: Object.fromEntries(articles.map((a) => [a.url, a.description])),
    aiGenerated: false,
  });

  if (!process.env.GROQ_API_KEY || articles.length === 0) return fallback();

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const completion = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.5,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You write concise news briefings. You return JSON only. You never invent facts " +
            "beyond what the supplied title and description support, and you never use " +
            "marketing language, exclamation marks, emoji, or second-person sales copy. " +
            "Write the way a person writes. Use plain sentences and ordinary punctuation. " +
            "Never use em dashes or en dashes; use a comma, a full stop, or two sentences " +
            "instead. Avoid the stock phrasings that give AI text away, such as " +
            "'in today's fast-paced world', 'it's worth noting', 'delve', 'landscape', " +
            "'underscores', 'highlights the importance of', and 'not only... but also'.",
        },
        {
          role: "user",
          content: `Write a briefing over these stories.

Return JSON shaped exactly:
{"intro": "one or two sentences on the through-line of today's stories",
 "blurbs": {"<article url>": "one sentence, max 25 words, on why this story matters"}}

Include every URL below as a key in "blurbs". Plain sentences, no markup.

STORIES:
${articles
  .map(
    (a) => `URL: ${a.url}
CATEGORY: ${a.category}
TITLE: ${a.title}
DESCRIPTION: ${a.description}`
  )
  .join("\n---\n")}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return fallback();

    const parsed = JSON.parse(raw) as { intro?: string; blurbs?: Record<string, string> };

    // The model may omit or hallucinate a URL, so every article is backfilled
    // from its own description rather than rendering a gap.
    const blurbs: Record<string, string> = {};
    for (const a of articles) {
      const candidate = parsed.blurbs?.[a.url];
      blurbs[a.url] =
        typeof candidate === "string" && candidate.trim().length > 0
          ? candidate.trim()
          : a.description;
    }

    return {
      intro:
        typeof parsed.intro === "string" && parsed.intro.trim().length > 0
          ? parsed.intro.trim()
          : fallback().intro,
      blurbs,
      aiGenerated: true,
    };
  } catch (error) {
    console.error("Briefing generation failed, using descriptions:", error);
    return fallback();
  }
}
