import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { EditorController } from "../../core";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import { commonmark, toggleStrongCommand, toggleEmphasisCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand, insertHrCommand } from "@milkdown/kit/preset/commonmark";
import { gfm, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history, undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { getMarkdown, replaceAll, callCommand } from "@milkdown/kit/utils";
import { $command, $useKeymap } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";

type MarkdownEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  modeOverride?: ViewMode | null;
};

type ViewMode = "write" | "preview";

function MilkdownEditorCore({
  markdown,
  onChange,
  readOnly = false,
  placeholder,
  onEditorReady
}: MarkdownEditorProps & { onEditorReady?: (editor: Editor) => void }) {
  const onChangeRef = useRef(onChange);
  const initialMarkdownRef = useRef(markdown);
  const editorRef = useRef<Editor | null>(null);
  const internalDocRef = useRef(markdown);
  const [showPlaceholder, setShowPlaceholder] = useState(!markdown.trim());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const { get, loading } = useEditor((root) => {
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialMarkdownRef.current);
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !readOnly
        }));
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          internalDocRef.current = md;
          setShowPlaceholder(!md.trim());
          onChangeRef.current(md);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener);

    return editor;
  }, [readOnly]);

  useEffect(() => {
    if (!loading) {
      const editor = get();
      if (editor) {
        editorRef.current = editor;
        onEditorReady?.(editor);
      }
    }
  }, [get, loading, onEditorReady]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || loading) return;
    
    if (markdown !== internalDocRef.current) {
      internalDocRef.current = markdown;
      try {
        editor.action(replaceAll(markdown));
        setShowPlaceholder(!markdown.trim());
      } catch {
        // Editor may not be ready
      }
    }
  }, [markdown, loading]);

  return (
    <div className={`wysiwyg-surface ${readOnly ? "readonly" : ""}`}>
      {placeholder && showPlaceholder && (
        <div className="wysiwyg-placeholder">{placeholder}</div>
      )}
      <Milkdown />
    </div>
  );
}

export function MarkdownEditor({
  markdown,
  onChange,
  readOnly = false,
  placeholder,
  modeOverride = null
}: MarkdownEditorProps) {
  const controller = useMemo(() => new EditorController(), []);
  const [mode, setMode] = useState<ViewMode>("write");
  const effectiveMode = modeOverride ?? mode;
  const modeLocked = modeOverride !== null;
  const editorInstanceRef = useRef<Editor | null>(null);

  useEffect(() => {
    if (modeOverride) {
      setMode(modeOverride);
    }
  }, [modeOverride]);

  const handleEditorReady = useCallback((editor: Editor) => {
    editorInstanceRef.current = editor;
  }, []);

  const executeCommand = useCallback((command: any) => {
    const editor = editorInstanceRef.current;
    if (!editor || readOnly) return;
    try {
      editor.action(callCommand(command.key));
    } catch (e) {
      console.warn("Command failed:", e);
    }
  }, [readOnly]);

  return (
    <div className="editor-shell">
      <div className="editor-toolbar">
        <div className="toolbar-group">
          <button
            type="button"
            onClick={() => executeCommand(toggleStrongCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Bold (Ctrl+B)"
            data-tooltip="Make selected text bold"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <text x="6" y="16" fontSize="12" fontWeight="700" fill="currentColor">
                B
              </text>
            </svg>
          </button>
          <button
            type="button"
            onClick={() => executeCommand(toggleEmphasisCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Italic (Ctrl+I)"
            data-tooltip="Make selected text italic"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <text
                x="9"
                y="16"
                fontSize="12"
                fontStyle="italic"
                fill="currentColor"
              >
                I
              </text>
            </svg>
          </button>
          <button
            type="button"
            onClick={() => executeCommand(toggleStrikethroughCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Strikethrough"
            data-tooltip="Add strikethrough to selected text"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
              <text x="7" y="17" fontSize="12" fill="currentColor">
                S
              </text>
            </svg>
          </button>
        </div>
        <span className="toolbar-divider" />
        <div className="toolbar-group">
          <button
            type="button"
            onClick={() => executeCommand(wrapInBulletListCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Bulleted List"
            data-tooltip="Convert to bulleted list"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="6" cy="7" r="2" fill="currentColor" />
              <circle cx="6" cy="12" r="2" fill="currentColor" />
              <circle cx="6" cy="17" r="2" fill="currentColor" />
              <line x1="10" y1="7" x2="20" y2="7" stroke="currentColor" strokeWidth="2" />
              <line x1="10" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
              <line x1="10" y1="17" x2="20" y2="17" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => executeCommand(wrapInOrderedListCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Numbered List"
            data-tooltip="Convert to numbered list"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <text x="4" y="8" fontSize="8" fill="currentColor">
                1
              </text>
              <text x="4" y="13" fontSize="8" fill="currentColor">
                2
              </text>
              <text x="4" y="18" fontSize="8" fill="currentColor">
                3
              </text>
              <line x1="10" y1="7" x2="20" y2="7" stroke="currentColor" strokeWidth="2" />
              <line x1="10" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
              <line x1="10" y1="17" x2="20" y2="17" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => executeCommand(wrapInBlockquoteCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Quote"
            data-tooltip="Convert to blockquote"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M7 8c0-2 1.5-3.5 3.5-3.5h1v2h-1c-1 0-1.5.5-1.5 1.5V9h2v6H5V9h2V8zm9 0c0-2 1.5-3.5 3.5-3.5h1v2h-1c-1 0-1.5.5-1.5 1.5V9h2v6h-6V9h2V8z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => executeCommand(insertHrCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Horizontal Rule"
            data-tooltip="Insert horizontal divider"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </div>
        <span className="toolbar-divider" />
        <div className="toolbar-group">
          <button
            type="button"
            onClick={() => executeCommand(undoCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Undo (Ctrl+Z)"
            data-tooltip="Undo last change"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M3 10h10a5 5 0 0 1 5 5v2M3 10l5-5M3 10l5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => executeCommand(redoCommand)}
            className="toolbar-button"
            disabled={readOnly}
            title="Redo (Ctrl+Shift+Z)"
            data-tooltip="Redo last change"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M21 10H11a5 5 0 0 0-5 5v2M21 10l-5-5M21 10l-5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="toolbar-group toolbar-tabs">
          <button
            type="button"
            className={`toolbar-button ${
              effectiveMode === "write" ? "active" : ""
            }`}
            onClick={() => {
              if (modeLocked) return;
              setMode("write");
            }}
            disabled={modeLocked}
            title="Edit mode"
            data-tooltip="Edit document with rich formatting"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 18l2.5-.5 9-9-2-2-9 9L4 18zm12.5-9.5 2-2a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0l-2 2 3 3z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className={`toolbar-button ${
              effectiveMode === "preview" ? "active" : ""
            }`}
            onClick={() => {
              if (modeLocked) return;
              setMode("preview");
            }}
            disabled={modeLocked}
            title="Preview mode"
            data-tooltip="Preview rendered document"
          >
            <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle cx="12" cy="12" r="3" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>

      <div className="editor">
        <div
          className={`editor-surface ${
            effectiveMode === "write" ? "is-active" : ""
          }`}
        >
          <MilkdownProvider>
            <MilkdownEditorCore
              markdown={markdown}
              onChange={onChange}
              readOnly={readOnly}
              placeholder={placeholder}
              onEditorReady={handleEditorReady}
            />
          </MilkdownProvider>
        </div>
        <div
          className={`markdown-preview ${
            effectiveMode === "preview" ? "is-active" : ""
          }`}
          dangerouslySetInnerHTML={{
            __html: controller.markdownToHtml(markdown)
          }}
        />
      </div>
    </div>
  );
}
