// Markdown -> plain prose, for TTS narration. Deliberately small and
// regex-based: the goal is speakable text, not a spec-complete parser.
// Code blocks are dropped entirely (reading code aloud is noise), links
// keep their text, images/cite tokens vanish, structural markers go away.

export function stripMarkdown(md: string): string {
  let text = md;

  // Fenced code blocks — remove the whole block, fences and contents.
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " ");

  // Citation tokens: [[cite:IDX:LABEL]].
  text = text.replace(/\[\[cite:[^\]]*\]\]/g, "");

  // Images vanish; links keep their visible text.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Inline code keeps its content.
  text = text.replace(/`([^`]*)`/g, "$1");

  // Line-start markers: headings, blockquotes, list bullets, numbering.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");

  // Horizontal rules.
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, "");

  // Emphasis markers (bold first so ** doesn't leave stray *).
  text = text.replace(/(\*\*|__)([^*_]+)\1/g, "$2");
  text = text.replace(/(\*|_)([^*_]+)\1/g, "$2");

  // Tables: drop separator rows, turn pipes into spaces.
  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "");
  text = text.replace(/\|/g, " ");

  // Collapse whitespace.
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ ?\n ?/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
