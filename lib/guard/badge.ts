/**
 * The README badge: a repository's dependency grade as a small SVG.
 *
 * Drawn here rather than fetched from a badge service, so it works with no
 * third party in the path and costs nothing. It shows a letter and a number.
 * It never says what is wrong: a badge is public, and "this repo has a
 * critical flaw in package X" is not something to print on its front page.
 */

const LABEL = "devlr";

/** Colour for the right-hand side. Fixed hex values: a badge has no theme to follow. */
const GRADE_COLOURS: Record<string, string> = {
  A: "#3f7d20",
  B: "#5a8f1e",
  C: "#a16207",
  D: "#c2410c",
  F: "#b91c1c",
};
const NEUTRAL = "#6b6b75";
const LABEL_BACKGROUND = "#18181b";

/**
 * Approximate advance widths for 11px Verdana, which is what badges are set
 * in. Exact metrics would need the font; this is within a pixel or two, and
 * `textLength` in the SVG makes the renderer fit the text to it regardless.
 */
function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if ("ijl.,:;|!'".includes(ch)) width += 3.4;
    else if ("ftr()[]/ ".includes(ch)) width += 4.4;
    else if ("mwMW".includes(ch)) width += 9.6;
    else if (ch >= "A" && ch <= "Z") width += 7.6;
    else width += 6.6;
  }
  return Math.round(width);
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface BadgeState {
  grade?: string | null;
  score?: number | null;
  /** Shown instead of a grade: "pending", "not found". */
  status?: string;
}

/** What the right-hand side says, and the sentence a screen reader gets. */
export function badgeText(state: BadgeState): { message: string; description: string; colour: string } {
  const { grade, score } = state;
  if (grade && typeof score === "number" && GRADE_COLOURS[grade]) {
    return {
      message: `deps ${grade} ${score}/100`,
      description: `Dependency health: grade ${grade}, ${score} out of 100, checked by Devlr`,
      colour: GRADE_COLOURS[grade],
    };
  }
  const status = state.status ?? "pending";
  return { message: `deps ${status}`, description: `Dependency health: ${status}`, colour: NEUTRAL };
}

export function renderBadge(state: BadgeState): string {
  const { message, description, colour } = badgeText(state);
  const pad = 7;
  const labelWidth = textWidth(LABEL) + pad * 2;
  const messageWidth = textWidth(message) + pad * 2;
  const width = labelWidth + messageWidth;
  const text = (value: string, x: number, w: number) =>
    `<text x="${x}" y="14" textLength="${w - pad * 2}" lengthAdjust="spacingAndGlyphs">${escape(value)}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escape(description)}">` +
    `<title>${escape(description)}</title>` +
    `<clipPath id="r"><rect width="${width}" height="20" rx="4"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${labelWidth}" height="20" fill="${LABEL_BACKGROUND}"/>` +
    `<rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${colour}"/>` +
    `</g>` +
    `<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="start">` +
    text(LABEL, pad, labelWidth) +
    text(message, labelWidth + pad, messageWidth) +
    `</g></svg>`
  );
}
