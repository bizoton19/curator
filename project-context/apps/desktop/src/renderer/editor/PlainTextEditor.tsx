import { useEffect, useMemo, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";

type PlainTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
};

export function PlainTextEditor({
  value,
  onChange,
  readOnly = false,
  placeholder
}: PlainTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const theme = EditorView.theme({
      "&": {
        height: "100%"
      },
      ".cm-scroller": {
        fontFamily: "var(--mono)",
        fontSize: "14px",
        lineHeight: "1.6"
      },
      ".cm-content": {
        padding: "16px",
        minHeight: "60vh"
      },
      ".cm-gutters": {
        background: "transparent",
        borderRight: "1px solid #efe5d6",
        color: "#8a7a6a"
      },
      ".cm-activeLineGutter": {
        background: "rgba(36, 79, 134, 0.08)"
      },
      ".cm-activeLine": {
        background: "rgba(36, 79, 134, 0.05)"
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        updateListener,
        readOnlyCompartment.of(EditorView.editable.of(!readOnly)),
        placeholder ? cmPlaceholder(placeholder) : [],
        theme
      ].flat()
    });

    viewRef.current = new EditorView({
      state,
      parent: editorRef.current
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [readOnlyCompartment, placeholder]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value }
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorView.editable.of(!readOnly))
    });
  }, [readOnly, readOnlyCompartment]);

  return (
    <div className="editor-shell">
      <div className="editor">
        <div ref={editorRef} className="codemirror-host" />
      </div>
    </div>
  );
}
