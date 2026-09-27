// Minimal Zig syntax highlighting for CodeMirror 6 (StreamLanguage)
import { StreamLanguage } from "@codemirror/language";
import { Tag, tags } from "@lezer/highlight";

// Own token names -> lezer tags (StreamLanguage requires a string tokenTable)
const zigTokenTable = {
  keyword: Tag.keyword,
  type: Tag.typeName,
  builtin: tags.special(tags.standard(tags.variableName)),
  variable: Tag.variableName,
  number: Tag.number,
  string: Tag.string,
  comment: Tag.lineComment,
};

const KEYWORDS = new Set([
  "asm", "break", "const", "continue", "defer", "else", "errdefer", "export",
  "extern", "for", "if", "inline", "noalias", "nosuspend", "opaque", "or",
  "orelse", "packed", "pub", "resume", "return", "linksection", "suspend",
  "switch", "test", "threadlocal", "try", "unreachable", "usingnamespace",
  "volatile", "while", "catch", "and", "fn", "var",
]);
const TYPES = new Set([
  "bool", "f16", "f32", "f64", "f128", "i8", "i16", "i32", "i64", "i128",
  "isize", "u8", "u16", "u32", "u64", "u128", "usize", "void", "noreturn",
  "type", "anyerror", "comptime_int", "comptime_float", "anyframe", "anytype",
  "c_int", "c_uint", "true", "false", "null", "undefined",
]);

export const zigLanguage = StreamLanguage.define({
  name: "zig",
  tokenTable: zigTokenTable,
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match('"')) {
      while (!stream.eol()) {
        if (stream.peek() === "\\") { stream.next(); stream.next(); continue; }
        if (stream.next() === '"') break;
      }
      return "string";
    }
    if (stream.match("'")) {
      while (!stream.eol() && stream.next() !== "'") {}
      return "string";
    }
    // multiline string literal (`\\...` lines)
    if (stream.peek() === "\\") {
      stream.skipToEnd();
      return "string";
    }
    // builtins @tagName etc.
    if (stream.match(/^@(?:"[^"]*"|[A-Za-z_]\w*)/)) return "builtin";
    if (stream.match(/[A-Za-z_]\w*/)) {
      const w = stream.current();
      if (KEYWORDS.has(w)) return "keyword";
      if (TYPES.has(w)) return "type";
      if (/^[A-Z]/.test(w)) return "type";
      return "variable";
    }
    if (stream.match(/0[xXbBoO][0-9a-fA-F_]+|\.?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/)) {
      return "number";
    }
    stream.next();
    return null;
  },
});
