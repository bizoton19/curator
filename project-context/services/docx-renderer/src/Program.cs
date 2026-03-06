using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/render/plain", ([FromBody] PlainRenderRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.Markdown) || string.IsNullOrWhiteSpace(request.OutputPath))
    {
        return Results.BadRequest(new { error = "markdown and outputPath are required" });
    }

    // TODO: Integrate Open XML SDK or OfficeIMO to generate DOCX output.
    return Results.Ok(new { success = true, outputPath = request.OutputPath });
});

app.MapPost("/render/template", ([FromBody] TemplateRenderRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.Markdown) || string.IsNullOrWhiteSpace(request.OutputPath))
    {
        return Results.BadRequest(new { error = "markdown and outputPath are required" });
    }

    // TODO: Load template and merge placeholders.
    return Results.Ok(new { success = true, outputPath = request.OutputPath });
});

app.Run();

record PlainRenderRequest(string Markdown, string OutputPath);
record TemplateRenderRequest(string Markdown, string TemplateId, string TemplatePath, string OutputPath);
