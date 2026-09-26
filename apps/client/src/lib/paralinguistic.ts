/**
 * Paralinguistic tags spoken by the narrator voice: they
 * live inline in beat prose, are performed by the TTS voice, and must be
 * rendered as styled chips on screen — never as raw bracketed text.
 */
export const PARALINGUISTIC_TAGS: string[] = [
  "laugh",
  "chuckle",
  "sigh",
  "gasp",
  "cough",
  "clear throat",
  "sniff",
  "groan",
  "shush",
];

export type DisplaySegment =
  | { type: "text"; value: string }
  | { type: "tag"; label: string };

/**
 * Split beat prose into display segments: supported tags (matched
 * case-insensitively) become tag segments with a lowercase label;
 * surrounding text is preserved verbatim. Bracketed text outside the
 * supported set stays plain text.
 */
export function toDisplaySegments(text: string): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  const tagPattern = /\[([^\]\n]+)\]/g;
  let cursor = 0;
  for (const match of text.matchAll(tagPattern)) {
    const label = match[1].trim().toLowerCase();
    if (!PARALINGUISTIC_TAGS.includes(label)) continue;
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, start) });
    }
    segments.push({ type: "tag", label });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}

/** Remove supported tags and collapse the doubled spaces they leave behind. */
export function stripTags(text: string): string {
  const plain = toDisplaySegments(text)
    .filter((segment): segment is { type: "text"; value: string } => segment.type === "text")
    .map((segment) => segment.value)
    .join("");
  return plain.replace(/ {2,}/g, " ");
}
