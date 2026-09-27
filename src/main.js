/* Ziglings Web — guided learning app (CodeMirror 6 + ZLS) */
import { createEditor } from "./editor.js";
import { t, setLang, getLang, applyStatic } from "./i18n.js";

const $ = (s) => document.querySelector(s);
let exercises = [], current = null, lastResult = null, editor = null;
let revealedHints = new Set(JSON.parse(localStorage.getItem("hints") || "[]"));

const CHAPTERS = [
  { name: () => t("ch0"), range: [1, 8] },
  { name: () => t("ch1"), range: [9, 17] },
  { name: () => t("ch2"), range: [18, 28] },
  { name: () => t("ch3"), range: [29, 35] },
  { name: () => t("ch4"), range: [36, 49] },
  { name: () => t("ch5"), range: [50, 54] },
  { name: () => t("ch6"), range: [55, 64] },
  { name: () => t("ch7"), range: [65, 75] },
  { name: () => t("ch8"), range: [76, 95] },
  { name: () => t("ch9"), range: [96, 115] },
  { name: () => t("ch10"), range: [999, 999] },
];
const chapterOf = (e) => CHAPTERS.findIndex(c => e.n >= c.range[0] && e.n <= c.range[1]);
const isFree = () => localStorage.getItem("freeMode") === "1";
function chapterUnlocked(ci) {
  if (isFree() || ci <= 0) return true;
  const prev = CHAPTERS[ci - 1];
  const need = exercises.filter(e => chapterOf(e) === ci - 1 && !e.skip);
  return need.every(e => e.done);
}

/* ---------- exercise list & ladder ---------- */
async function loadExercises() {
  exercises = await (await fetch("/api/exercises")).json();
  renderList();
  updateProgress();
  const first = exercises.find(e => !e.done && !e.skip && chapterUnlocked(chapterOf(e)));
  if (first) select(first.file);
}

function renderList(filter = "") {
  const ul = $("#exList");
  ul.innerHTML = "";
  const f = filter.trim().toLowerCase();
  CHAPTERS.forEach((ch, ci) => {
    const items = exercises.filter(e => chapterOf(e) === ci &&
      (!f || e.title.toLowerCase().includes(f) || String(e.n).includes(f)));
    if (!items.length) return;
    const total = exercises.filter(e => chapterOf(e) === ci && !e.skip);
    const done = total.filter(e => e.done).length;
    const unlocked = chapterUnlocked(ci);
    const head = document.createElement("li");
    head.className = "chapter" + (unlocked ? "" : " locked");
    head.innerHTML = `<span class="ch-icon">${unlocked ? (done === total.length ? "🏅" : "📖") : "🔒"}</span>` +
      `<span class="ch-name">${ch.name()}</span>` +
      `<span class="ch-prog">${done}/${total.length}</span>` +
      `<span class="ch-bar"><span style="width:${100 * done / Math.max(total.length, 1)}%"></span></span>`;
    ul.appendChild(head);
    if (!unlocked) {
      const li = document.createElement("li");
      li.className = "locked-msg";
      li.textContent = t("lockedMsg");
      ul.appendChild(li);
      return;
    }
    for (const e of items) {
      const li = document.createElement("li");
      li.dataset.file = e.file;
      li.className = (e.done ? "done " : "") + (e.skip ? "skipped " : "") +
        (current && current.file === e.file ? "active" : "");
      li.innerHTML = `<span class="ex-num">${String(e.n).padStart(3, "0")}</span>` +
        `<span class="ex-title">${e.title}</span>` +
        `<span class="ex-mark">${e.done ? "✅" : (e.skip ? "⏭" : "")}</span>`;
      li.onclick = () => select(e.file);
      ul.appendChild(li);
    }
  });
}

function updateProgress() {
  const done = exercises.filter(e => e.done).length;
  $("#progressFill").style.width = (100 * done / exercises.length) + "%";
  $("#progressText").textContent = `${done} / ${exercises.length}`;
}

/* ---------- exercise view ---------- */
async function select(file) {
  const isScratch = file === "__scratch__";
  const meta = isScratch
    ? { file: "scratch.zig", title: t("scratchTitle"), n: 0, output: "", hint: null, skip: false, scratch: true }
    : exercises.find(e => e.file === file);
  if (!meta) return;
  if (isScratch) file = "scratch.zig";
  const data = await (await fetch("/api/exercise/" + file)).json();
  current = { ...meta, original: data.original, uri: data.uri, rootUri: data.rootUri, scratch: isScratch };
  $("#exTitle").textContent = isScratch
    ? "🧪 " + t("scratchTitle")
    : `${String(meta.n).padStart(3, "0")} · ${meta.title}` +
    (meta.skip ? " " + t("skipped") : "");
  mountEditor(data.code);
  renderLesson(data.original);
  $("#outputCard").classList.add("hidden");
  $("#runStatus").textContent = "";
  $("#btnSubmit").disabled = true;
  $("#btnSubmit").style.display = current.scratch ? "none" : "";
  $("#btnHint").style.display = current.scratch ? "none" : "";
  lastResult = null;
  renderRefLinks();
  loadChat();
  syncArgsInput();
  const argsBoxReset = $("#argsInput");
  if (argsBoxReset) argsBoxReset.value = "";
  $("#btnSubmit").style.display = current.scratch ? "none" : "";
  $("#btnHint").style.display = current.scratch ? "none" : "";
  renderList($("#search").value);
  if (location.hash !== "#" + file) history.replaceState(null, "", "#" + file);
}

let lintTimer;
function scheduleLint() {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(async () => {
    if (!current || !editor) return;
    try {
      const res = await (await fetch("/api/lint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: current.file, code: code() })
      })).json();
      editor.setDiagnostics((res.diagnostics || []).map(d => {
        const line = editor.view.state.doc.line(Math.min(d.line + 1, editor.view.state.doc.lines));
        const pos = Math.min(line.from + d.col, line.to);
        return { from: pos, to: Math.min(pos + 1, line.to), message: d.message, severity: "error" };
      }));
    } catch {}
  }, 600);
}

function mountEditor(code) {
  if (editor) { editor.destroy(); editor = null; }
  try {
    editor = createEditor({
      parent: $("#editorHost"),
      doc: code,
      fileUri: current.uri,
      rootUri: current.rootUri,
      onRun: run,
      onChange: () => { saveDraft(); scheduleLint(); },
    });
  } catch (e) {
    $("#editorHost").textContent = t("editorFail") + e.message;
    console.error(e);
    return;
  }
  editor.view.focus();
}

let lessonOriginal = "";      // 当前题目的原始英文说明
let lessonTranslated = null;  // null = 显示原文；否则为译文

async function translateLesson() {
  if (!current || !lessonOriginal) return;
  const btn = $("#btnLessonTr");
  const target = getLang() === "en" ? "en" : "zh";
  const cacheKey = `lessonTr:${current.file}:${target}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached && lessonTranslated === null) {
    lessonTranslated = cached;
    $("#lesson").textContent = cached;
    btn.textContent = "↺";
    return;
  }
  if (lessonTranslated !== null) {  // 切回原文
    lessonTranslated = null;
    renderLessonText(lessonOriginal);
    btn.textContent = "🌐";
    return;
  }
  btn.disabled = true;
  btn.textContent = "⏳";
  try {
    const res = await (await fetch("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: [lessonOriginal], target })
    })).json();
    if (res.error || !res.translations) { btn.textContent = "⚠"; btn.title = res.error || "failed"; return; }
    lessonTranslated = res.translations[0];
    try { localStorage.setItem(cacheKey, lessonTranslated); } catch {}
    renderLessonText(lessonTranslated);
    btn.textContent = "↺";
  } finally {
    btn.disabled = false;
  }
}

function renderLessonText(text) {
  const html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/\?\?\?/g, '<span class="todo">???</span>');
  $("#lesson").innerHTML = html;
}

$("#btnLessonTr").onclick = translateLesson;

function renderLesson(src) {
  if (current && current.scratch) {
    $("#lesson").textContent = t("scratchLesson");
    return;
  }
  lessonOriginal = lessonText(src);
  lessonTranslated = null;
  const btn = $("#btnLessonTr");
  btn.textContent = "🌐";
  const cacheKey = `lessonTr:${current.file}:${getLang() === "en" ? "en" : "zh"}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    lessonTranslated = cached;
    renderLessonText(cached);
    btn.textContent = "↺";
  } else {
    renderLessonText(lessonOriginal);
  }
  if (!lessonOriginal.trim()) $("#lesson").textContent = "（本题没有注释说明，直接读代码吧）";
}
function lessonText(src) {
  const lines = src.split("\n");
  const lesson = [];
  for (const ln of lines) {
    if (/^\s*\/\//.test(ln)) lesson.push(ln.replace(/^\s*\/\/ ?/, ""));
    else if (lesson.length && ln.trim()) break;
  }
  while (lesson.length && !lesson[lesson.length - 1].trim()) lesson.pop();
  return lesson.join("\n");
}

const code = () => editor ? editor.view.state.doc.toString() : "";
let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (current) fetch("/api/solution/" + current.file, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code() })
    });
  }, 800);
}

/* ---------- run & submit ---------- */
/* 程序参数输入（实验场 / cookbook 显示） */
function syncArgsInput() {
  const box = $("#argsBox");
  if (!box) return;
  box.style.display = current && (current.scratch || current.file.startsWith("cookbook_")) ? "" : "none";
}
async function run() {
  if (!current) return;
  $("#runStatus").textContent = t("running"); $("#runStatus").className = "";
  const endpoint = current.file.startsWith("cookbook_") ? "/api/cookbook/run" : "/api/run";
  const payload = { file: current.file, id: current.file.replace(/^cookbook_|\.zig$/g, ""), code: code() };
  const argsVal = ($("#argsInput")?.value || "").trim();
  if (argsVal) payload.args = argsVal.split(/\s+/);
  const res = await (await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })).json();
  lastResult = res;
  showResult(res, false);
}
function showResult(res, submitted) {
  $("#outputCard").classList.remove("hidden");
  const out = $("#output");
  if (current && current.scratch) {
    if (res.timeout) {
      $("#runStatus").textContent = `⏱ 超时（${res.timeoutSecs || 150}s）`;
      $("#runStatus").className = "err";
      const partial = res.outputSeen || (res.stdout || "") + (res.stderr || "");
      out.innerHTML = `<span class="err">⏱ 编译+运行超过 ${res.timeoutSecs || 150}s。</span>` +
        (partial ? `\n程序超时前已产生的输出：\n${escapeHtml(partial)}` : "") +
        `\n\n首次编译新的 std 模块较慢——<b>再运行一次</b>通常命中缓存就会快很多。\n` +
        `网络/服务类示例（TCP、HTTP 服务端）会一直等待连接，超时自动结束属于正常现象。`;
      out.scrollTop = 0;
      return;
    }
    $("#runStatus").textContent = res.passed ? t("scratchOk") : t("scratchFail");
    $("#runStatus").className = res.passed ? "ok" : "err";
    out.innerHTML = escapeHtml((res.stdout || "") + (res.stderr || "")) || "(无输出)";
    out.scrollTop = 0;
    return;
  }
  if (res.passed) {
    $("#runStatus").textContent = submitted ? t("passedSubmit") : t("passedRun");
    $("#runStatus").className = "ok";
    out.innerHTML = `<span class="ok">${escapeHtml(res.outputSeen || res.stdout || res.expected)}</span>\n\n` +
      `<span class="ok">${escapeHtml(submitted ? t("passedHintSubmit") : t("passedHintRun"))}</span>`;
    if (submitted) {
      const idx = exercises.findIndex(e => e.file === current.file);
      exercises[idx].done = true;
      renderList($("#search").value); updateProgress();
    }
    $("#btnSubmit").disabled = false;
  } else if (res.timeout) {
    $("#runStatus").textContent = `⏱ 超时（${res.timeoutSecs || 30}s）`;
    $("#runStatus").className = "err";
    const partial = res.outputSeen || res.stdout || "";
    out.innerHTML = `<span class="err">⏱ 编译+运行超过 ${res.timeoutSecs || 30}s。</span>` +
      (partial ? `\n程序超时前已产生的输出：\n${escapeHtml(partial)}` : "") +
      `\n\n首次编译新的 std 模块会比较慢——<b>再运行一次</b>通常命中缓存就会快很多。\n` +
      `如果是网络/服务类示例（TCP、HTTP 服务端），它一直在等待连接，超时自动结束属于正常现象。`;
  } else {
    const compileErr = !res.stderr.includes("expected this output") && res.returncode !== 0;
    $("#runStatus").textContent = compileErr ? t("compileErr") : t("outputMismatch");
    $("#runStatus").className = "err";
    out.innerHTML =
      (res.stderr ? `<span class="err">${escapeHtml(res.stderr)}</span>\n` : "") +
      `<span class="exp">${escapeHtml(t("expected"))}${escapeHtml(res.expected)}</span>\n` +
      `<span>${escapeHtml(t("actual"))}${escapeHtml(res.outputSeen || res.stdout || "(空)")}</span>`;
    if (submitted) $("#btnSubmit").disabled = true;
  }
  out.scrollTop = 0;
}

async function submit() {
  if (!current) return;
  if (current.id && current.file.startsWith("cookbook_")) { await submitChallenge(); return; }
  $("#runStatus").textContent = t("submitting"); $("#runStatus").className = "";
  const res = await (await fetch("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: current.file, code: code() })
  })).json();
  lastResult = res;
  showResult(res, true);
}

function escapeHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

/* ---------- hint ---------- */
$("#btnHint").onclick = () => {
  if (!current) return;
  if (!revealedHints.has(current.file)) {
    revealedHints.add(current.file);
    localStorage.setItem("hints", JSON.stringify([...revealedHints]));
  }
  $("#outputCard").classList.remove("hidden");
  $("#output").innerHTML = `<span class="exp">${escapeHtml(t("hintTitle"))}${escapeHtml(current.hint || t("noHint"))}</span>`;
};

/* ---------- chat ---------- */
import { marked } from "marked";
import DOMPurify from "dompurify";
marked.setOptions({ breaks: true, gfm: true });

function renderMd(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ""), {
    ADD_ATTR: ["target"],
  });
  return html;
}

function decorateMsg(div) {
  // external links open in new tab
  div.querySelectorAll("a[href]").forEach(a => { a.target = "_blank"; a.rel = "noopener"; });
  // copy buttons on code blocks
  div.querySelectorAll("pre").forEach(pre => {
    if (pre.querySelector(".md-copy")) return;
    const btn = document.createElement("button");
    btn.className = "md-copy";
    btn.textContent = t("copy");
    btn.onclick = () => {
      navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
        btn.textContent = t("copied");
        setTimeout(() => { btn.textContent = t("copy"); }, 1200);
      });
    };
    pre.style.position = "relative";
    pre.appendChild(btn);
  });
}

const chatLog = $("#chatLog");
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role + (role === "assistant" ? " md" : "");
  if (role === "assistant") {
    div.innerHTML = renderMd(text);
    decorateMsg(div);
  } else {
    div.textContent = text;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}
/* ---------- 每道题独立的聊天记录（localStorage 持久化） ---------- */
const WELCOME = () => t("aiWelcome");
let chatHistory = [];
const chatStore = JSON.parse(localStorage.getItem("chats") || "{}");

function saveChat() {
  if (!current) return;
  if (chatHistory.length) chatStore[current.file] = chatHistory;
  else delete chatStore[current.file];
  try { localStorage.setItem("chats", JSON.stringify(chatStore)); } catch {}
}
function loadChat() {
  chatHistory = current ? (chatStore[current.file] || []) : [];
  chatLog.innerHTML = "";
  addMsg("assistant", WELCOME());
  for (const m of chatHistory) addMsg(m.role, m.content);
}
function clearChat() {
  chatHistory = [];
  if (current) { delete chatStore[current.file]; }
  try { localStorage.setItem("chats", JSON.stringify(chatStore)); } catch {}
  loadChat();
}

async function sendChat(extraContext) {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text && !extraContext) return;
  const askFile = current ? current.file : null; // 竞态保护：回复回来时若已切题则丢弃
  const content = extraContext ? extraContext + (text ? "\n\n" + text : "") : text;
  input.value = "";
  addMsg("user", content);
  chatHistory.push({ role: "user", content });
  const pending = addMsg("assistant", t("thinking"));
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: systemMessages().concat(chatHistory) })
    });
    if ((current ? current.file : null) !== askFile) return; // 已切换题目，丢弃
    if (!res.ok || !(res.headers.get("Content-Type") || "").includes("text/event-stream")) {
      const data = await res.json().catch(() => ({}));
      pending.className = "msg error";
      pending.textContent = data.error || (t("reqFailed") + res.status);
      return;
    }
    // 流式读取 SSE，逐字渲染
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", reply = "", flushTimer = null;
    const render = () => {
      flushTimer = null;
      pending.innerHTML = renderMd(reply);
      decorateMsg(pending);
      chatLog.scrollTop = chatLog.scrollHeight;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.error) { pending.className = "msg error"; pending.textContent = ev.error; return; }
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) {
          reply += delta;
          if (!flushTimer) flushTimer = setTimeout(render, 80); // 节流渲染
        }
      }
    }
    clearTimeout(flushTimer);
    if ((current ? current.file : null) !== askFile) return; // 流结束前切题，丢弃
    if (!reply.trim()) {
      // 上游限流/不稳定时会给出空流：不入历史，给可操作提示
      pending.className = "msg error";
      pending.textContent = "⚠ 上游返回了空回复（接口可能限流或不稳定）。请重试，或在 ⚙ 检查接口状态。";
      chatHistory.pop(); // 移除这条没有回答的用户消息，保持历史干净
      return;
    }
    pending.innerHTML = renderMd(reply); decorateMsg(pending);
    chatHistory.push({ role: "assistant", content: reply });
    saveChat();
  } catch (e) {
    pending.className = "msg error";
    pending.textContent = t("reqFailed") + e;
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}
function systemMessages() {
  if (!current) return [{ role: "system", content: "你是 Zig 语言的助教，用简体中文回答，简洁、循序渐进，鼓励学生自己思考。" }];
  if (current.scratch) return [{
    role: "system",
    content: "你是 Zig 实验场的助教，用简体中文回答。用户在自由练习 Zig 代码，帮助解释语法、std API 用法和报错信息。",
    }];
  return [{
    role: "system",
    content: `你是 Ziglings 练习题的 Zig 助教，用简体中文回答。风格：引导式教学，先解释概念，多给提示，除非学生明确要求否则不要直接给出完整答案。` +
      `当前练习：第 ${current.n} 题 ${current.title}（文件 ${current.file}）。\n` +
      `期望输出：\n${current.output}\n` +
      (current.hint ? `官方提示：${current.hint}\n` : "") +
      `学生当前代码：\n\`\`\`zig\n${code()}\n\`\`\`` +
      (lastResult && !lastResult.passed && lastResult.stderr ? `\n最近的编译/运行输出：\n${lastResult.stderr.slice(0, 3000)}` : "")
  }];
}
$("#btnSend").onclick = () => sendChat();
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
function applyQuickLabels() {
  document.querySelectorAll('#chatQuick button[data-q]').forEach(b => {
    b.dataset.q = t(b.dataset.i18nQ);
  });
}
applyQuickLabels();
document.querySelectorAll('#chatQuick button[data-q]').forEach(b => {
  b.onclick = () => { $('#chatInput').value = b.dataset.q; sendChat(); };
});
$("#btnChatClear").onclick = clearChat;
$("#btnExplain").onclick = () => {
  if (!lastResult) { $("#chatInput").value = "请检查我的代码并指出问题。"; sendChat(); return; }
  const ctx = `我运行了程序但没有通过。请帮我分析下面的编译器输出，解释错误原因并给出下一步提示（不要直接给完整答案）：\n\`\`\`\n${(lastResult.stderr || lastResult.stdout || "").slice(0, 4000)}\n\`\`\``;
  $("#chatInput").value = "";
  sendChat(ctx);
};

/* ---------- reference：练习 ↔ 文档精确关联 ---------- */
const LANGREF = "/p/ziglang.org/documentation/0.16.0/";
const STD = "/p/ziglang.org/documentation/0.16.0/std/#";

const TOPICS = [
  { match: /hello|std|import|print/, name: "Hello World 与 import", doc: "#Hello-World" },
  { match: /assign|const|var/, name: "变量与赋值", doc: "#Variables" },
  { match: /array/, name: "数组", doc: "#Arrays" },
  { match: /string/, name: "字符串字面量", doc: "#String-Literals-and-Unicode-Code-Point-Literals" },
  { match: /if/, name: "if 表达式", doc: "#if" },
  { match: /while/, name: "while 循环", doc: "#while" },
  { match: /for/, name: "for 循环", doc: "#for" },
  { match: /function|fn/, name: "函数", doc: "#Functions" },
  { match: /error/, name: "错误处理", doc: "#Errors" },
  { match: /defer/, name: "defer / errdefer", doc: "#defer" },
  { match: /switch/, name: "switch", doc: "#switch" },
  { match: /struct/, name: "结构体", doc: "#struct" },
  { match: /enum/, name: "枚举", doc: "#enum" },
  { match: /union/, name: "联合类型", doc: "#union" },
  { match: /option|optional|no_value|values/, name: "可选类型", doc: "#Optionals" },
  { match: /pointer|manypointers/, name: "指针", doc: "#Pointers" },
  { match: /slice/, name: "切片", doc: "#Slices" },
  { match: /comptime|quiz8/, name: "comptime 与泛型", doc: "#comptime" },
  { match: /method/, name: "方法", doc: "#struct" },
  { match: /integers/, name: "整数", doc: "#Integers" },
  { match: /floats/, name: "浮点数", doc: "#Floats" },
  { match: /coercion/, name: "类型强转", doc: "#Casting" },
  { match: /sentinel/, name: "哨兵值", doc: "#Sentinel-Terminated-Arrays" },
  { match: /anonymous/, name: "匿名结构", doc: "#Anonymous-Struct-Literals" },
  { match: /interfaces/, name: "接口惯用法", doc: "#struct" },
  { match: /async/, name: "async / await", doc: "#Async-Functions" },
  { match: /alloc|memory/, name: "内存管理", doc: "#Memory" },
  { match: /labeled|label/, name: "标签块与标签循环", doc: "#Labeled-while" },
  { match: /vector/, name: "向量 (SIMD)", doc: "#Vectors" },
  { match: /pack/, name: "packed struct", doc: "#packed-struct" },
  { match: /quiz/, name: "综合测验", doc: null },
  { match: /thread|format|files|bit|token/, name: "线程 / 文件 / 位运算", doc: "#Assembly" },
];

function renderRefLinks() {
  if (!current) return;
  const hits = TOPICS.filter(topic => topic.match.test(current.file + " " + current.title));

  // 从题目源码提取实际用到的 std API → std 文档符号直链
  const apis = new Set();
  for (const m of (current.original || "").matchAll(/std\.[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const parts = m[0].split(".");
    if (parts.length >= 2) apis.add(parts.slice(0, 3).join(".")); // 最多取三级
    if (apis.size >= 10) break;
  }

  let html = hits.map(h =>
    `🔹 <a href="#" class="doc-jump" data-anchor="${LANGREF}${h.doc ? h.doc : ""}">${h.name}</a>`).join("<br>");
  if (apis.size) {
    html += `<br><b class="muted" style="font-size:.8rem">本题用到的 std API：</b><br>` +
      [...apis].map(a => `🔸 <a href="#" class="std-jump" data-sym="${a}">${a}</a>`).join("<br>");
  }
  $("#refLinks").innerHTML = html || t("noSpecificRef");
  $("#cheatsheet").innerHTML = hits.map(h =>
    `<details class="cheat"><summary>${h.name}</summary><pre>${escapeHtml(h.code)}</pre></details>`).join("");

  $("#refLinks").querySelectorAll(".doc-jump").forEach(a => {
    a.onclick = (e) => { e.preventDefault(); document.querySelector('.tab[data-tab="ref"]').click(); loadDoc(a.dataset.anchor); };
  });
  $("#refLinks").querySelectorAll(".std-jump").forEach(a => {
    a.onclick = (e) => { e.preventDefault(); document.querySelector('.tab[data-tab="ref"]').click(); loadDoc(STD + a.dataset.sym); };
  });
}

/* ---------- tabs, nav, settings, ladder controls ---------- *//* ---------- tabs, nav, settings, ladder controls ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab, .tabpane").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $("#tab-" + t.dataset.tab).classList.add("active");
});
$("#btnRun").onclick = run;
// 全局快捷键：焦点不在编辑器（如聊天框、说明区）时也能 Ctrl/Cmd+Enter 运行
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    // 编辑器内已由 CodeMirror keymap 处理；这里兜底其它区域
    const inEditor = document.querySelector(".cm-content")?.contains(document.activeElement);
    if (!inEditor) { e.preventDefault(); run(); }
  }
});
$("#btnSubmit").onclick = submit;
$("#btnPrev").onclick = () => nav(-1);
$("#btnNext").onclick = () => nav(1);
function nav(d) {
  if (!current) return;
  const i = exercises.findIndex(e => e.file === current.file);
  select(exercises[(i + d + exercises.length) % exercises.length].file);
}
$("#btnReset").onclick = async () => {
  if (current && current.original) {
    editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: current.original } });
    saveDraft();
  }
};
$("#search").addEventListener("input", (e) => renderList(e.target.value));
$("#btnScratch").onclick = () => select("__scratch__").then(syncArgsInput);

/* ---------- zig-cookbook：现场拉取 + 解析 ---------- */
let cookbookMode = false, cookbookList = null;
const btnCookbook = document.createElement("button");
btnCookbook.id = "btnCookbook";
btnCookbook.textContent = t("cookbookBtn");
btnCookbook.title = "zig-cookbook（现场拉取解析）";
$("#btnScratch").parentElement.insertBefore(btnCookbook, $("#btnScratch"));

async function ensureCookbookList() {
  if (cookbookList) return cookbookList;
  const [list, progress] = [await (await fetch("/api/cookbook?lang=" + getLang())).json(),
                            await (await fetch("/api/cookbook/progress")).json()];
  for (const r of list) r.done = !!progress[r.id];
  cookbookList = list;
  return cookbookList;
}
function renderCookbookList() {
  const ul = $("#exList");
  ul.innerHTML = "";
  let last = null;
  for (const r of cookbookList) {
    if (r.chapter !== last) {
      last = r.chapter;
      const head = document.createElement("li");
      head.className = "chapter";
      const done = cookbookList.filter(x => x.chapter === r.chapter && x.done).length;
      const total = cookbookList.filter(x => x.chapter === r.chapter).length;
      head.innerHTML = `<span class="ch-icon">📖</span><span class="ch-name">${r.chapterName}</span>` +
        `<span class="ch-prog">${done}/${total}</span>`;
      ul.appendChild(head);
    }
    const li = document.createElement("li");
    li.className = current && current.file === "cookbook_" + r.id + ".zig" ? "active" : "";
    li.innerHTML = `<span class="ex-title">${r.title}</span>${r.done ? ' <span class="ex-mark">✅</span>' : ""}`;
    li.onclick = () => selectRecipe(r.id);
    ul.appendChild(li);
  }
}
btnCookbook.onclick = async () => {
  cookbookMode = !cookbookMode;
  btnCookbook.textContent = cookbookMode ? t("cookbookBack") : t("cookbookBtn");
  if (cookbookMode) {
    btnCookbook.textContent = t("loading");
    await ensureCookbookList();
    btnCookbook.textContent = t("cookbookBack");
    current = null;
    renderCookbookList();
    $("#exTitle").textContent = "📖 zig-cookbook — " + t("cookbookSub");
    $("#lesson").textContent = t("cookbookHome");
    editor && editor.destroy(); editor = null;
    $("#outputCard").classList.add("hidden");
  } else {
    renderList($("#search").value);
  }
};

async function selectRecipe(id) {
  cookbookMode = true;
  const res = await (await fetch(`/api/cookbook/recipe/${id}?lang=${getLang() === "en" ? "en-US" : "zh-CN"}`)).json();
  if (res.error) { addMsg("error", res.error); return; }
  current = { file: "cookbook_" + id + ".zig", title: res.title, n: 0, id,
              output: "", hint: null, skip: false, scratch: true,
              original: res.original, uri: res.uri, rootUri: res.rootUri, prose: res.prose };
  mountEditor(res.code);
  $("#lesson").innerHTML = renderMd(`### ${res.title}\n\n${res.prose}\n\n> Cookbook 示例：直接运行参考实现，修改后 Ctrl+Enter 立即看结果。`);
  $("#outputCard").classList.add("hidden");
  $("#runStatus").textContent = "";
  $("#btnSubmit").style.display = "none";
  $("#btnHint").style.display = "none";
  renderListSearchSafe();
  loadChatForCookbook(id);
  syncArgsInput();
  const ab = $("#argsInput");
  if (ab) ab.value = "";
  renderCookbookStdLinks();
  setupCookbookButtons(id);
  if (editor) editor.view.focus();
}

/* 挑战模式 / Playground 按钮（按可判题性动态生成） */
let challengeActive = false;
function setupCookbookButtons(id) {
  $("#btnSubmit").style.display = "none";
  $("#btnHint").style.display = "none";
  let btn = $("#btnChallenge");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "btnChallenge";
    $("#runRow").insertBefore(btn, $("#btnExplain"));
  }
  btn.disabled = true;
  btn.textContent = "⏳ " + t("checking");
  btn.onclick = async () => { await startChallenge(id); };
  (async () => {
    try {
      const info = await (await fetch(`/api/cookbook/challenge/${id}?lang=${getLang() === "en" ? "en-US" : "zh-CN"}`)).json();
      if (info.challengeable) {
        current.expected = info.expected;
        current.skeleton = info.skeleton;
        btn.textContent = "🎯 " + t("challengeMode");
        btn.disabled = false;
        btn.title = t("challengeTip");
      } else {
        btn.textContent = "🧪 " + t("playgroundOpen");
        btn.disabled = false;
        btn.title = t("playgroundTip");
        btn.onclick = () => openPlayground(id);
      }
    } catch (e) {
      btn.textContent = "🧪 " + t("playgroundOpen");
      btn.disabled = false;
      btn.onclick = () => openPlayground(id);
    }
  })();
}

async function startChallenge(id) {
  challengeActive = true;
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: current.skeleton || "" } });
  $("#btnSubmit").style.display = "";
  $("#btnSubmit").textContent = "📤 " + t("submitChallenge");
  $("#btnSubmit").disabled = false;
  $("#runStatus").textContent = t("challengeStarted");
  $("#runStatus").className = "";
  addMsg("assistant", t("challengeChatIntro"));
}

function openPlayground(id) {
  challengeActive = false;
  const file = "playground_" + id + ".zig";
  current.file = file;
  const saved = localStorage.getItem("pg:" + file);
  if (saved) editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: saved } });
  $("#runStatus").textContent = t("playgroundStarted");
  $("#runStatus").className = "";
  $("#btnSubmit").style.display = "none";
  addMsg("assistant", t("playgroundChatIntro"));
}

async function submitChallenge() {
  $("#runStatus").textContent = t("submitting"); $("#runStatus").className = "";
  const res = await (await fetch("/api/cookbook/judge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: current.id, code: code(), lang: getLang() === "en" ? "en-US" : "zh-CN" })
  })).json();
  lastResult = res;
  $("#outputCard").classList.remove("hidden");
  const out = $("#output");
  if (res.passed) {
    $("#runStatus").textContent = "🎯 " + t("challengePassed");
    $("#runStatus").className = "ok";
    out.innerHTML = `<span class="ok">${escapeHtml(res.outputSeen)}</span>\n\n<span class="ok">🎉 ${t("challengePassedMsg")}</span>`;
    markCookbookDone(current.id, true);
  } else {
    $("#runStatus").textContent = t("outputMismatch");
    $("#runStatus").className = "err";
    out.innerHTML =
      (res.stderr ? `<span class="err">${escapeHtml(res.stderr)}</span>\n` : "") +
      `<span class="exp">${escapeHtml(t("expected"))}${escapeHtml(res.expected)}</span>\n` +
      `<span>${escapeHtml(t("actual"))}${escapeHtml(res.outputSeen || "(空)")}</span>`;
  }
  out.scrollTop = 0;
}
function renderListSearchSafe() {
  if (cookbookMode) renderCookbookList(); else renderList($("#search").value);
}

const CHAPTER_STD = {
  "01": "std.fs", "02": "std.crypto", "03": "std.time", "04": "std.net",
  "05": "std.http", "06": "std.Random", "07": "std.Thread", "08": "std.process",
  "09": "std.SemanticVersion", "10": "std.json", "11": "std.math.complex",
  "12": "std.DoublyLinkedList", "13": "std.process", "15": "std.ascii",
};
function renderCookbookStdLinks() {
  if (!current || !current.id) return;
  const chapter = current.id.slice(0, 2);
  const apis = new Set();
  for (const m2 of (current.original || "").matchAll(/std\.[A-Za-z_][A-Za-z0-9_.]*/g)) {
    const parts = m2[0].split(".");
    if (parts.length >= 2) apis.add(parts.slice(0, 3).join("."));
    if (apis.size >= 10) break;
  }
  const mod = CHAPTER_STD[chapter];
  let html = mod ? `🔹 <a href="#" class="std-jump" data-sym="${mod}">${mod} 模块文档</a>` : "";
  if (apis.size) html += `<br>` + [...apis].map(a => `🔸 <a href="#" class="std-jump" data-sym="${a}">${a}</a>`).join("<br>");
  $("#refLinks").innerHTML = html || t("noSpecificRef");
  $("#refLinks").querySelectorAll(".std-jump").forEach(a => {
    a.onclick = (e) => { e.preventDefault(); document.querySelector('.tab[data-tab="ref"]').click(); loadDoc(STD + a.dataset.sym); };
  });
}
function loadChatForCookbook(id) {
  chatHistory = (JSON.parse(localStorage.getItem("chats") || "{}"))["cookbook_" + id] || [];
  chatLog.innerHTML = "";
  addMsg("assistant", t("cookbookTutorPrefix") + "「" + current.title + "」。" + t("cookbookTutorSuffix"));
  for (const m of chatHistory) addMsg(m.role, m.content);
}
const freeBtn = $("#btnFree");
function syncFreeBtn() {
  freeBtn.textContent = isFree() ? t("freeOn") : t("freeOff");
  freeBtn.classList.toggle("primary", isFree());
}
freeBtn.onclick = () => {
  localStorage.setItem("freeMode", isFree() ? "0" : "1");
  syncFreeBtn(); renderList($("#search").value);
};
syncFreeBtn();

const dlg = $("#settingsDlg");
$("#btnSettings").onclick = async () => {
  const [cfg, env] = [await (await fetch("/api/config")).json(),
                      await (await fetch("/api/env")).json()];
  $("#cfgBase").value = cfg.baseUrl || "";
  $("#cfgModel").value = cfg.model || "";
  $("#cfgKey").value = "";
  const sel = $("#cfgZigSel");
  sel.innerHTML = "";
  const cur = env.selected || (env.zigs[0] && env.zigs[0].version);
  for (const z of env.zigs) {
    const opt = document.createElement("option");
    opt.value = z.version;
    opt.textContent = `Zig ${z.version}` + (z.version === cur ? " ✓" : "");
    if (z.version === cur) opt.selected = true;
    sel.appendChild(opt);
  }
  dlg.showModal();
};
$("#cfgCancel").onclick = () => dlg.close();
$("#cfgSave").onclick = async () => {
  await fetch("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: $("#cfgBase").value, model: $("#cfgModel").value, apiKey: $("#cfgKey").value })
  });
  const version = $("#cfgZigSel").value;
  const env = await (await fetch("/api/env")).json();
  if (version && version !== env.selected) {
    const res = await (await fetch("/api/env/select", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version })
    })).json();
    if (res.ok) { location.reload(); return; } // 题库已切换，整页刷新
  }
  dlg.close();
  addMsg("assistant", t("aiSaved"));
};
$("#btnDocs").onclick = () => document.querySelector('.tab[data-tab="ref"]').click();

/* ---------- 可拖拽分栏 ---------- */
function setupSplit(handle, axis, getStart, apply, invert = false) { // axis: "x" | "y"
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add("resizing");
    const startPos_ = axis === "x" ? e.clientX : e.clientY;
    const startSize = getStart();
    const move = (ev) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      const dx = (pos - startPos_) * (invert ? -1 : 1);
      apply(startSize + dx);
      if (editor) editor.view.requestMeasure();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

const root = document.documentElement;
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const sideW = parseFloat(localStorage.getItem("sideW")) || 240;
const dockW = parseFloat(localStorage.getItem("dockW")) || 380;
const lessonH = parseFloat(localStorage.getItem("lessonH")) || window.innerHeight * 0.24;
root.style.setProperty("--side-w", sideW + "px");
root.style.setProperty("--dock-w", dockW + "px");
root.style.setProperty("--lesson-h", lessonH + "px");

$("#sidebar").style.width = "var(--side-w)";
$("#rightDock").style.width = "var(--dock-w)";
$("#lesson").style.height = "var(--lesson-h)";

setupSplit($("#splitSide"), "x",
  () => parseFloat(root.style.getPropertyValue("--side-w")) || 240,
  (size) => {
    const w = clamp(size, 170, window.innerWidth * 0.6);
    root.style.setProperty("--side-w", w + "px");
    localStorage.setItem("sideW", w);
  });
setupSplit($("#splitDock"), "x",
  () => parseFloat(root.style.getPropertyValue("--dock-w")) || 380,
  (size) => {
    const w = clamp(size, 260, window.innerWidth * 0.7);
    root.style.setProperty("--dock-w", w + "px");
    localStorage.setItem("dockW", w);
  }, true); // invert：拖左 = 变宽，面板边缘跟随鼠标
setupSplit($("#splitLesson"), "y",
  () => parseFloat(root.style.getPropertyValue("--lesson-h")) || 192,
  (size) => {
    const h = clamp(size, 40, window.innerHeight * 0.6);
    root.style.setProperty("--lesson-h", h + "px");
    localStorage.setItem("lessonH", h);
  });


/* ---------- 文档嵌入与 AI 翻译 ---------- */
const docFrame = $("#docFrame");
function loadDoc(url) {
  docFrame.classList.remove("hidden");
  $("#docHome").classList.add("hidden");
  // 走路径式子树代理，相对资源(wasm/js)自动同源加载；hash 原样保留供 std 文档 SPA 路由
  const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
  let path = url.split("#")[0]
    .replace(/^https:\/\/ziglang\.org\//, "")
    .replace(/^\/?p\/ziglang\.org\//, "");   // 幂等：防止重复前缀
  docFrame.src = "/p/ziglang.org/" + path + hash;
}
$("#btnDocLoad").onclick = () => loadDoc($("#docPreset").value);
$("#btnDocRestore").onclick = () => { stopDocTranslate(); if (docFrame.src) docFrame.src = docFrame.src; };
document.querySelectorAll(".doc-link").forEach(a => {
  a.onclick = (e) => { e.preventDefault(); loadDoc(a.href); };
});

let docXlate = null; // {observer, queue, pending, target}

function stopDocTranslate() {
  if (docXlate) { stopDocTranslateCleanup(docXlate); docXlate = null; }
  const btn = $("#btnDocTranslate");
  btn.disabled = false;
  btn.textContent = t("docTranslate");
}

function updateXlateBtn() {
  const btn = $("#btnDocTranslate");
  if (!docXlate) return;
  btn.textContent = `⏳ ${t("translating")} ${docXlate.done}`;
}

async function flushXlateQueue() {
  const st = docXlate;
  if (!st || st.running) return;
  st.running = true;
  while (st.queue.length) {
    const batch = [];
    let size = 0;
    while (st.queue.length && size < 3000 && batch.length < 40) {
      const n = st.queue.shift();
      const v = n.nodeValue.trim();
      if (!st.map.has(v)) { st.map.set(v, null); batch.push(v); }
      st.nodes.set(n, v);
    }
    st.done = Math.min(st.total, st.done + batch.length);
    updateXlateBtn();
    try {
      const res = await (await fetch("/api/translate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: batch, target: st.target })
      })).json();
      if (res.translations) batch.forEach((orig, i) => st.map.set(orig, res.translations[i] ?? orig));
    } catch (e) { /* 失败的段落保留原文 */ }
    // 应用所有已完成的翻译
    for (const [node, orig] of st.nodes) {
      const tr = st.map.get(orig);
      if (tr && node.nodeValue.trim() === orig) node.nodeValue = node.nodeValue.replace(orig, tr);
    }
  }
  st.running = false;
  updateXlateBtn();
  if (!st.queue.length && st.doneEls && st.doneEls.size >= st.blocksLen) { const b = $("#btnDocTranslate"); b.textContent = "✓ " + t("translated"); }
}

$("#btnDocTranslate").onclick = () => {
  if (docXlate) { stopDocTranslate(); return; }
  if (!docFrame.src.includes("/p/ziglang.org/")) { loadDoc($("#docPreset").value); return; }
  const doc = docFrame.contentDocument;
  if (!doc || !doc.body) return;
  const skip = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "SVG", "KBD", "TEXTAREA"]);
  const blocks = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,summary,figcaption,blockquote,a,span,label,button,title")]
    .filter(el => !skip.has(el.tagName) && el.offsetParent !== null &&
                  [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim().length > 1));
  if (!blocks.length) return;
  const nodes = [];
  const seen = new Set();
  for (const el of blocks) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim().length > 1 && !seen.has(n.nodeValue.trim())) {
        seen.add(n.nodeValue.trim());
        nodes.push(n);
      }
    }
  }
  docXlate = { queue: [], nodes: new Map(), map: new Map(), total: nodes.length, blocksLen: blocks.length, done: 0, running: false, target: getLang() === "en" ? "zh" : "en", win: null, harvest: null, doneEls: null };
  $("#btnDocTranslate").disabled = false;
  updateXlateBtn();
  // 滚动到哪翻到哪：监听 iframe 滚动，把视口附近块元素的文本节点入队
  const docWin = doc.defaultView;
  const harvest = () => {
    if (!docXlate) return;
    const st = doc.scrollingElement ? doc.scrollingElement.scrollTop : docWin.scrollY;
    const vh = docWin.innerHeight;
    for (const el of blocks) {
      if (docXlate.doneEls.has(el)) continue;
      const top = el.getBoundingClientRect().top + st;
      if (top > st + vh + 400) continue;   // 还在下方，未排序但可提前跳出（blocks 按文档序）
      if (top < st - 600) { docXlate.doneEls.add(el); continue; } // 已翻过上方
      docXlate.doneEls.add(el);
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && !docXlate.nodes.has(n) && n.nodeValue.trim().length > 1) {
          docXlate.queue.push(n);
        }
      }
    }
    flushXlateQueue();
  };
  docXlate.harvest = harvest;
  docXlate.doneEls = new Set();
  docXlate.win = docWin;
  docWin.addEventListener("scroll", harvest, { passive: true });
  harvest();
};

function stopDocTranslateCleanup(st) {
  if (st && st.harvest && st.win) st.win.removeEventListener("scroll", st.harvest);
}

/* language toggle *//* language toggle */
$("#btnLang").onclick = () => {
  setLang(getLang() === "zh" ? "en" : "zh");
  location.reload(); // 简单起见：切换后整页刷新，全部文案重建
};

/* layout toggles — 编辑器吃满剩余空间 */
$("#btnDock").onclick = () => {
  document.body.classList.toggle("dock-hidden");
  localStorage.setItem("dockHidden", document.body.classList.contains("dock-hidden") ? "1" : "0");
  if (editor) editor.view.requestMeasure();
};
function toggleLesson() {
  document.body.classList.toggle("lesson-collapsed");
  $("#btnLessonFold").textContent = document.body.classList.contains("lesson-collapsed") ? "▸" : "▾";
  if (editor) editor.view.requestMeasure();
}
$("#btnLesson").onclick = toggleLesson;
$("#btnLessonFold").onclick = toggleLesson;
$("#btnOutClose").onclick = () => { $("#outputCard").classList.add("hidden"); if (editor) editor.view.requestMeasure(); };

/* cookbook 完成打勾 */
async function markCookbookDone(id, done) {
  await fetch("/api/cookbook/done", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, done })
  });
  if (cookbookList) {
    const r = cookbookList.find(x => x.id === id);
    if (r) r.done = done;
    renderListSearchSafe();
  }
}
if (localStorage.getItem("dockHidden") === "1") document.body.classList.add("dock-hidden");
if (window.innerWidth < 1080) document.body.classList.add("dock-hidden");

/* ---------- boot ---------- */
$("#exTitle").textContent = t("pickExercise");
loadExercises().then(() => {
  const h = location.hash.slice(1);
  if (h && exercises.some(e => e.file === h)) select(h);
});
