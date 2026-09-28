// CodeMirror 6 editor with ZLS language-server support.
import { EditorView, keymap, lineNumbers, highlightActiveLine,
         hoverTooltip,
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

const STD_DOCS_BASE = "https://ziglang.org/documentation/0.16.0/std/#";

// ---------- 常用 std API 签名（离线速查，ZLS 不可用时兜底） ----------
const STD_SIGS = {
  "std.debug.print": "fn print(comptime fmt: []const u8, args: anytype) void",
  "std.fs.cwd": "fn cwd() Dir",
  "std.json.parseFromSlice": "fn parseFromSlice(comptime T, allocator, s, options) !Parsed(T)",
  "std.base64.standard.Encoder": "fn encode(dest: []u8, source: []const u8) []const u8",
  "std.base64.standard.Decoder": "fn decode(dest: []u8, source: []const u8) !void",
  "std.Thread.spawn": "fn spawn(options, comptime func, args) !Thread",
  "std.Thread.sleep": "fn sleep(nanoseconds: u64) void",
  "std.crypto.hash.sha2.Sha256": "Sha256 — SHA-2 256 位哈希",
  "std.crypto.pwhash.pbkdf2": "fn pbkdf2(dk, password, salt, rounds, Prf) !void",
  "std.SemanticVersion.parse": "fn parse(text: []const u8) !SemanticVersion",
  "std.process.Init": "std.process.Init — 新版进程初始化参数（io/gpa/args）",
  "std.testing.expect": "fn expect(ok: bool) !void",
  "std.testing.expectEqual": "fn expectEqual(expected, actual) !void",
  "std.testing.expectEqualStrings": "fn expectEqualStrings(expected, actual) !void",
  "std.ArrayList": "ArrayList(comptime T) type — 可增长数组",
  "std.net.IpAddress.parse": "fn parse(name: []const u8, port: u16) !IpAddress",
};

// Zig 内建函数签名
const BUILTIN_SIGS = {
  "@import": "fn @import(path: []const u8) type",
  "@intCast": "fn @intCast(expr: anytype) anytype",
  "@floatCast": "fn @floatCast(expr: anytype) anytype",
  "@panic": "fn @panic(message: []const u8) noreturn",
  "@typeName": "fn @typeName(T: anytype) []const u8",
  "@TypeOf": "fn @TypeOf(expr) type",
  "@sizeOf": "fn @sizeOf(T: type) comptime_int",
};

// 本地文档分析：查找 word 的本地声明
function findLocalSig(docText, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = docText.split("\n");
  for (const ln of lines) {
    const fnM = ln.match(new RegExp("(?:pub )?fn\\s+" + esc + "\\s*\\((.*)\\)(?:\\s*(\\!?[A-Za-z_][\\w.]*))?"));
    if (fnM) {
      const ret = fnM[2] ? " " + fnM[2] : "";
      return "fn " + word + "(" + fnM[1].trim() + ")" + ret;
    }
  }
  for (const ln of lines) {
    const vM = ln.match(new RegExp("(pub )?(const|var)\\s+" + esc + "(\\s*:\\s*[^=]+)?\\s*="));
    if (vM) {
      return vM[2] + " " + word + (vM[3] ? " " + vM[3].trim() : " (推断类型)") + " = …";
    }
  }
  return null;
}

// 悬停主题提示工厂
function makeZigHover(hoverLookup) {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    let start = pos - line.from, end = pos - line.from;
    while (start > 0 && /[A-Za-z0-9_.@]/.test(text[start - 1])) start--;
    while (end < text.length && /[A-Za-z0-9_.@]/.test(text[end])) end++;
    let word = text.slice(start, end);
    if (word === "std" && text[end] === ".") {
      let e2 = end;
      while (e2 < text.length && /[A-Za-z0-9_.]/.test(text[e2])) e2++;
      word = text.slice(start, e2);
      end = e2;
    }
    if (!word || word === "." || word.length < 2) return null;
    const docText = view.state.doc.toString();
    const localSig = findLocalSig(docText, word);
    const stdSig = STD_SIGS[word] || null;
    const builtinSig = BUILTIN_SIGS[word] || null;
    const info = hoverLookup ? hoverLookup(word) : null;
    if (!info && !localSig && !stdSig && !builtinSig) return null;
    const dom = document.createElement("div");
    dom.className = "zig-hover";
    const title = document.createElement("div");
    title.className = "zig-hover-title";
    title.textContent = word;
    dom.appendChild(title);
    const sig = localSig || stdSig || builtinSig;
    if (sig) {
      const sigEl = document.createElement("div");
      sigEl.className = "zig-hover-sig";
      sigEl.textContent = sig;
      dom.appendChild(sigEl);
    }
    if (info && info.desc) {
      const d = document.createElement("div");
      d.className = "zig-hover-desc";
      d.textContent = info.desc;
      dom.appendChild(d);
    }
    let docUrl = null;
    if (info && info.doc) docUrl = info.doc;
    else if (word.startsWith("std.")) docUrl = STD_DOCS_BASE + word;
    if (docUrl) {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = "📖 打开文档 →";
      a.onclick = (e) => { e.preventDefault(); onOpenDoc && onOpenDoc(docUrl); };
      dom.appendChild(a);
    }
    return { pos: line.from + start, end: line.from + end,
             create: () => ({ dom }) };
  }, { hoverTime: 350 });
}

export function createEditor({ parent, doc, fileUri, rootUri, onRun, onChange, hoverLookup, onOpenDoc }) {
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
      makeZigHover(hoverLookup),
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
