// CodeMirror 6 editor with ZLS language-server support.
import { EditorView, keymap, lineNumbers, highlightActiveLine,
         highlightActiveLineGutter, drawSelection, highlightSpecialChars,
         dropCursor } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, foldGutter, foldKeymap, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { languageServerWithTransport } from "codemirror-languageserver";
import { zigLanguage } from "./zig.js";
import { WsLspTransport } from "./transport.js";

/* Catppuccin Mocha */
const C = {
  base: "#1e1e2e", mantle: "#181825", crust: "#11111b",
  surface0: "#313244", surface1: "#45475a",
  overlay0: "#6c7086", overlay2: "#9399b2",
  text: "#cdd6f4", subtext1: "#bac2de",
  mauve: "#cba6f7", lavender: "#b4befe", green: "#a6e3a1",
  red: "#f38ba8", peach: "#fab387", yellow: "#f9e2af",
  blue: "#89b4fa", sky: "#89dceb", flamingo: "#f2cdcd",
};

const darkTheme = EditorView.theme({
  "&": { color: C.text, backgroundColor: "transparent", fontSize: "0.9rem", height: "100%" },
  ".cm-content": { fontFamily: "ui-monospace, Consolas, monospace", caretColor: C.mauve, paddingBottom: "40px" },
  ".cm-scroller": { fontFamily: "ui-monospace, Consolas, monospace", overflow: "auto", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: C.mantle, color: C.overlay0, border: "none" },
  ".cm-activeLine": { backgroundColor: "rgba(203,166,247,.07)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(203,166,247,.12)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(137,180,250,.30) !important" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: C.mauve },
  ".cm-tooltip": { backgroundColor: C.surface0, border: "1px solid " + C.surface1, color: C.text },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: C.mauve, color: C.crust },
  ".cm-completionLabel": { color: C.text },
  ".cm-diagnostic-error": { borderLeft: "3px solid " + C.red },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy " + C.red },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy " + C.yellow },
  ".cm-searchMatch": { backgroundColor: "rgba(249,226,175,.25)" },
  ".cm-selectionMatch": { backgroundColor: "rgba(166,227,161,.20)" },
  ".cm-foldPlaceholder": { backgroundColor: C.surface1, border: "none", color: C.subtext1 },
});

const zigHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.comment, color: C.overlay0, fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.moduleKeyword], color: C.mauve },
  { tag: [t.typeName, t.className, t.namespace], color: C.yellow },
  { tag: [t.number, t.bool, t.null, t.atom], color: C.peach },
  { tag: [t.string, t.special(t.string), t.regexp], color: C.green },
  { tag: [t.escape], color: C.sky },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: C.blue },
  { tag: [t.variableName, t.propertyName], color: C.text },
  { tag: [t.special(t.variableName)], color: C.red },
  { tag: [t.definition(t.variableName)], color: C.flamingo },
  { tag: [t.operator, t.punctuation, t.bracket], color: C.subtext1 },
  { tag: [t.meta], color: C.lavender },
  { tag: [t.labelName], color: C.sky },
  { tag: [t.invalid], color: C.red },
]), { fallback: true });

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return proto + "://" + location.host + "/lsp";
}

/**
 * Create an editor instance wired to ZLS for one exercise document.
 * Returns { view, destroy, setDoc }.
 */
export function createEditor({ parent, doc, fileUri, rootUri, onRun, onChange }) {
  const transport = new WsLspTransport(wsUrl());
  const lsp = languageServerWithTransport({
    documentUri: fileUri,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "ziglings-runs" }],
    languageId: "zig",
    transport,
  });

  // 注意：必须是绑定数组（不能再包一层 keymap.of，否则嵌套扩展被忽略）
  const runBinding = {
    key: "Mod-Enter",
    run: () => { onRun && onRun(); return true; },
  };

  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
      history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
      highlightActiveLine(), highlightSelectionMatches(),
      lintGutter(),
      keymap.of([runBinding, indentWithTab, ...closeBracketsKeymap, ...defaultKeymap,
                 ...historyKeymap, ...foldKeymap, ...completionKeymap,
                 ...lintKeymap]),
      zigLanguage,
      zigHighlight,
      darkTheme,
      lsp,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && onChange) onChange(u.state.doc.toString());
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    setDiagnostics: (diags) => view.dispatch(setDiagnostics(view.state, diags)),
    destroy() {
      try { transport.close(); } catch {}
      view.destroy();
    },
  };
}
