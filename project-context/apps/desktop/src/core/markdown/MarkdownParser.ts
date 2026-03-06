export type ParsedMarkdown = {
  raw: string;
};

export class MarkdownParser {
  parse(raw: string): ParsedMarkdown {
    return { raw };
  }
}
