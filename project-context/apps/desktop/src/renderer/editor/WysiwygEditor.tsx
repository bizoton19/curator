import { useEffect, useRef, useCallback } from "react";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { getMarkdown } from "@milkdown/kit/utils";

type WysiwygEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
};

function MilkdownEditor({
  markdown,
  onChange,
  readOnly = false,
  placeholder
}: WysiwygEditorProps) {
  const onChangeRef = useRef(onChange);
  const initialMarkdownRef = useRef(markdown);
  const editorRef = useRef<Editor | null>(null);
  const isUpdatingRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const { get } = useEditor((root) => {
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialMarkdownRef.current);
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          if (!isUpdatingRef.current) {
            onChangeRef.current(md);
          }
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener);

    return editor;
  }, []);

  useEffect(() => {
    const editor = get();
    if (editor) {
      editorRef.current = editor;
    }
  }, [get]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const currentMarkdown = editor.action(getMarkdown());
    if (markdown !== currentMarkdown) {
      isUpdatingRef.current = true;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const tr = state.tr.replaceWith(
          0,
          state.doc.content.size,
          state.schema.nodeFromJSON({ type: "doc", content: [] }).content
        );
        view.dispatch(tr);
      });
      
      editor.destroy();
      editorRef.current = null;
      initialMarkdownRef.current = markdown;
      isUpdatingRef.current = false;
    }
  }, [markdown]);

  return (
    <div className={`wysiwyg-editor ${readOnly ? "readonly" : ""}`}>
      {placeholder && !markdown && (
        <div className="wysiwyg-placeholder">{placeholder}</div>
      )}
      <Milkdown />
    </div>
  );
}

export function WysiwygEditor(props: WysiwygEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditor {...props} />
    </MilkdownProvider>
  );
}
