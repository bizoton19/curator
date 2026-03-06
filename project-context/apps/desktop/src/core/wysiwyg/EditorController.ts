import { marked } from "marked";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export class EditorController {
  private turndown: TurndownService;

  constructor() {
    marked.setOptions({
      gfm: true,
      breaks: true
    });
    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "_"
    });
    this.turndown.use(gfm);
  }

  markdownToHtml(markdown: string): string {
    const result = marked.parse(markdown ?? "");
    return typeof result === "string" ? result : "";
  }

  htmlToMarkdown(html: string): string {
    return this.turndown.turndown(html ?? "");
  }
}
