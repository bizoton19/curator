export type RenderPlainRequest = {
  markdown: string;
  outputPath: string;
};

export type RenderTemplateRequest = {
  markdown: string;
  templateId: string;
  templatePath: string;
  outputPath: string;
};

export class DocxClient {
  constructor(private baseUrl: string) {}

  async renderPlain(request: RenderPlainRequest) {
    const res = await fetch(`${this.baseUrl}/render/plain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!res.ok) throw new Error("DOCX render failed");
    return res.json();
  }

  async renderTemplate(request: RenderTemplateRequest) {
    const res = await fetch(`${this.baseUrl}/render/template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!res.ok) throw new Error("DOCX template render failed");
    return res.json();
  }
}
