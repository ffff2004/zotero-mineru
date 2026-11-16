/** The fixed name belongs to the runtime export and legacy attachments. */
export const EXPORT_MARKDOWN = "markdown.md";
export const LEGACY_GENERATION_MARKER = "zotero-mineru-generation:v1";
export const GENERATION_MARKER = "zotero-mineru-generation:v2";

/** Zotero wraps saved plain-text attachment notes in a paragraph on reload. */
export function matchesGenerationMarker(note: string, marker: string): boolean {
  return note === marker || note === `<p>${marker}</p>`;
}

export function isMarkdownFilename(name: string): boolean {
  return (
    !name.startsWith(".") &&
    name.length > 3 &&
    /\.md$/i.test(name) &&
    !Array.from(name).some(isControl) &&
    validName(name) === name
  );
}

function isControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

function validName(name: string): string {
  return (
    Zotero.File as typeof Zotero.File & {
      getValidFileName(name: string): string;
    }
  ).getValidFileName(name);
}

export function markdownFilename(pdfFilename: string): string {
  const safeStem = [...pdfFilename.replace(/\.pdf$/i, "")]
    .map((char) => (isControl(char) || /[<>:"/\\|?*]/.test(char) ? "_" : char))
    .join("");
  let stem = validName(safeStem).replace(/[. ]+$/g, "");
  if (
    stem.startsWith(".") ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)
  ) {
    stem = "_" + stem;
  }
  return stem ? `${stem}.md` : EXPORT_MARKDOWN;
}
