/* Ziglings Web — guided learning app (CodeMirror 6 + ZLS) */
import { createEditor } from "./editor.js";
import { t, setLang, getLang, applyStatic } from "./i18n.js";
const ESC = "\n";  // 模板字符串换行（历史命名，用于 innerHTML 拼接）

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
  syncSourceSelect();
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
  // ziglings / 实验场不显示 Cookbook 的挑战/Playground 模式按钮
  const mcb = $("#btnModeChallenge"), mpg = $("#btnModePlayground");
  if (mcb) mcb.style.display = "none";
  if (mpg) mpg.style.display = "none";
  if (!current.scratch) $("#btnSubmit").textContent = t("submit");
  recipeMode = null;
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
  const box = $("#argsInput");
  if (!box) return;
  box.style.display = current && (current.scratch || current.file.startsWith("cookbook_")) ? "" : "none";
}
/* ---------- 后台运行（实时输出，可多个同时跑） ---------- */
const bgRuns = new Map();   // runId -> {title, timer, port}
let focusedRun = null;      // 输出面板当前聚焦的 run

function renderBgChips() {
  let box = $("#bgChips");
  if (!box) {
    box = document.createElement("div");
    box.id = "bgChips";
    $("#runRow").after(box);
  }
  box.innerHTML = "";
  for (const [rid, meta] of bgRuns) {
    const chip = document.createElement("span");
    chip.className = "bg-chip" + (rid === focusedRun ? " active" : "");
    chip.innerHTML = `<span class="dot ${meta.running ? "run" : "done"}"></span>${escapeHtml(meta.title)}` +
      (meta.port ? ` <b>:${meta.port}</b>` : "");
    chip.onclick = () => { focusedRun = rid; renderBgChips(); pollBgOnce(rid, true); };
    const stop = document.createElement("button");
    stop.textContent = meta.running ? "■" : "✕";
    stop.title = meta.running ? "停止" : "移除";
    stop.onclick = async (e) => {
      e.stopPropagation();
      if (meta.running) await fetch("/api/runbg/stop/" + rid, { method: "POST" });
      clearInterval(meta.timer);
      bgRuns.delete(rid);
      if (focusedRun === rid) focusedRun = null;
      renderBgChips();
    };
    chip.appendChild(stop);
    box.appendChild(chip);
  }
}

async function pollBgOnce(rid, force) {
  if (focusedRun !== rid && !force) return;
  const meta = bgRuns.get(rid);
  if (!meta) return;
  try {
    const st = await (await fetch("/api/runbg/status/" + rid)).json();
    const out = $("#output");
    $("#outputCard").classList.remove("hidden");
    if (st.output) out.textContent = st.output;
    // 自动检测监听端口
    const pm = st.output.match(/Listening on 127\.0\.0\.1:(\d+)/);
    if (pm && !meta.port) {
      meta.port = pm[1];
      if (!$("#argsInput").value) {
        $("#argsInput").value = pm[1];
        $("#argsInput").style.borderColor = "var(--ok)";
        setTimeout(() => { $("#argsInput").style.borderColor = ""; }, 1500);
      }
      renderBgChips();
    }
    out.scrollTop = out.scrollHeight;
    if (!st.running) {
      meta.running = false;
      renderBgChips();
      $("#runStatus").textContent = st.returncode === 0 ? t("scratchOk") : (t("exitWith") + st.returncode);
      $("#runStatus").className = st.returncode === 0 ? "ok" : "err";
      clearInterval(meta.timer);
    } else {
      $("#runStatus").textContent = "🟢 运行中";
      $("#runStatus").className = "ok";
    }
  } catch {}
}

async function run() {
  if (!current) return;
  const isZiglings = !current.scratch && !current.file.startsWith("cookbook_");
  if (isZiglings) {  // 练习判题保持同步模式
    $("#runStatus").textContent = t("running"); $("#runStatus").className = "";
    const res = await (await fetch("/api/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: current.file, code: code() })
    })).json();
    lastResult = res;
    showResult(res, false);
    return;
  }
  // cookbook / scratch / playground → 后台运行，实时输出
  const payload = { file: current.file, id: current.id || "", code: code() };
  if (current.zbeTestMode) payload.mode = "test";
  const argsVal = ($("#argsInput")?.value || "").trim();
  if (argsVal) payload.args = argsVal.split(/\s+/);
  const { runId } = await (await fetch("/api/runbg/start", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })).json();
  bgRuns.set(runId, { title: `${current.title}`, running: true, timer: null, port: null });
  focusedRun = runId;
  $("#outputCard").classList.remove("hidden");
  $("#output").textContent = "";
  renderBgChips();
  meta_poll: {
    const meta = bgRuns.get(runId);
    meta.timer = setInterval(() => pollBgOnce(runId), 900);
  }
  await pollBgOnce(runId, true);
}
function showResult(res, submitted) {
  $("#outputCard").classList.remove("hidden");
  const out = $("#output");
  if (current && current.scratch) {
    if (res.timeout) {
      $("#runStatus").textContent = `⏱ 超时（${res.timeoutSecs || 150}s）`;
      $("#runStatus").className = "err";
      const partial = res.outputSeen || (res.stdout || "") + (res.stderr || "");
      out.innerHTML = `<span class="err">⏱ ${t("timeout")}（${res.timeoutSecs || 150}s）</span>${ESC}${ESC}${t("timeoutHint")}`;
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
    out.innerHTML = `<span class="err">⏱ ${t("timeout")}（${res.timeoutSecs || 30}s）</span>${ESC}${ESC}${t("timeoutHint")}`;
  } else {
    const compileErr = !res.stderr.includes("expected this output") && res.returncode !== 0;
    $("#runStatus").textContent = compileErr ? t("compileErr") : t("outputMismatch");
    $("#runStatus").className = "err";
    out.innerHTML =
      (res.stderr ? `<span class="err">${escapeHtml(res.stderr)}</span>\n` : "") +
      `<span class="exp">${escapeHtml(t("expected"))}${escapeHtml(res.expected)}</span>\n` +
      `<span>${escapeHtml(t("actual"))}${escapeHtml(res.outputSeen || res.stdout || "(空)")}</span>`;
  }
  out.scrollTop = 0;
}

async function submit() {
  if (!current) return;
  if (recipeMode === "challenge") { await submitChallenge(); return; }
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
  const withCode = hits.filter(h => h.code);
  $("#cheatsheet").innerHTML = withCode.map(h =>
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
$("#search").addEventListener("input", (e) => {
  if (cookbookMode) renderCookbookList(e.target.value);
  else if (zbeMode) renderZbeList(e.target.value);
  else renderList(e.target.value);
});


/* ---------- zig-cookbook：现场拉取 + 解析 ---------- */
let cookbookMode = false, cookbookList = null;
let zbeMode = false, zbeList = null, zbeSnippets = null, zbeSnippetIdx = 0;
let zbeProgress = {};
let zbeProgressLoaded = false;


async function ensureCookbookList() {
  if (cookbookList) return cookbookList;
  const [list, progress] = [await (await fetch("/api/cookbook?lang=" + getLang())).json(),
                            await (await fetch("/api/cookbook/progress")).json()];
  for (const r of list) r.done = !!progress[r.id];
  cookbookList = list;
  return cookbookList;
}
function renderCookbookList(filter = "") {
  const ul = $("#exList");
  syncSourceSelect();
  ul.innerHTML = "";
  let last = null;
  const f = (filter || "").trim().toLowerCase();
  for (const r of cookbookList) {
    if (f && !(r.title.toLowerCase().includes(f) || r.id.includes(f) || r.chapterName.toLowerCase().includes(f))) continue;
    if (r.chapter !== last) {
      last = r.chapter;
      const head = document.createElement("li");
      head.className = "chapter";
      const done = cookbookList.filter(x => x.chapter === r.chapter && x.done).length;
      const total = cookbookList.filter(x => x.chapter === r.chapter).length;
      head.innerHTML = `<span class="ch-icon">📖</span><span class="ch-name">${escapeHtml(r.chapterName)}</span>` +
        `<span class="ch-prog">${done}/${total}</span>`;
      ul.appendChild(head);
    }
    const li = document.createElement("li");
    li.className = current && current.file === "cookbook_" + r.id + ".zig" ? "active" : "";
    li.innerHTML = `<span class="ex-title">${escapeHtml(r.title)}</span>${r.done ? ' <span class="ex-mark">✅</span>' : ""}`;
    li.onclick = () => selectRecipe(r.id);
    ul.appendChild(li);
  }
}




/* ---------- 内容源切换（下拉） ---------- */
const sourceSelect = $("#sourceSelect");
function syncSourceSelect() {
  sourceSelect.value = cookbookMode ? "cookbook" : (zbeMode ? "zbe" : (current && current.scratch && current.file === "scratch.zig" ? "scratch" : "ziglings"));
}
function btnLoading(on) { sourceSelect.disabled = on; }
async function switchSource(mode) {
  cookbookMode = (mode === "cookbook");
  zbeMode = (mode === "zbe");
  current = null;
  lastResult = null;
  challengeActive = false;
  recipeMode = null;
  $("#outputCard").classList.add("hidden");
  $("#runStatus").textContent = "";
  try {
  if (mode === "cookbook") {
    sourceSelect.disabled = true;
    await ensureCookbookList();
    sourceSelect.disabled = false;
    renderCookbookList($("#search").value);
    $("#exTitle").textContent = "📖 zig-cookbook — " + t("cookbookSub");
    $("#lesson").textContent = t("cookbookHome");
  } else if (mode === "zbe") {
    sourceSelect.disabled = true;
    await ensureZbeProgress();
    sourceSelect.disabled = false;
    renderZbeList($("#search").value);
    $("#exTitle").textContent = "📘 Zig by Example";
    $("#lesson").textContent = t("zbeHome");
  } else if (mode === "scratch") {
    syncSourceSelect();
    await select("__scratch__");
    return;
  } else {
    renderList($("#search").value);
    $("#exTitle").textContent = t("pickExercise");
    $("#lesson").textContent = "";
    $("#btnSubmit").textContent = "📤 " + t("submit");
    const mcb = $("#btnModeChallenge"), mpg = $("#btnModePlayground");
    if (mcb) mcb.style.display = "none";
    if (mpg) mpg.style.display = "none";
  }
  } catch (e) {
    // 拉取失败：回退到 ziglings 并提示
    cookbookMode = false; zbeMode = false;
    renderList($("#search").value);
    $("#exTitle").textContent = "⚠ " + String(e).slice(0, 60);
    $("#lesson").textContent = t("sourceLoadFail");
  }
  editor && editor.destroy(); editor = null;
  syncSourceSelect();
}
sourceSelect.onchange = () => switchSource(sourceSelect.value);
function buildSourceOptions() {
  sourceSelect.innerHTML =
    `<option value="ziglings">📝 ${t("srcZiglings")}</option>` +
    `<option value="cookbook">📖 zig-cookbook</option>` +
    `<option value="zbe">📘 Zig by Example</option>` +
    `<option value="scratch">🧪 ${t("srcScratch")}</option>`;
  syncSourceSelect();
}
buildSourceOptions();

async function markZbeDone(slug, done) {
  await fetch("/api/zbe/done", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, done })
  });
  if (zbeList) {
    const p = zbeList.find(x => x.slug === slug);
    if (p) p.done = done;
    renderZbeList($("#search").value);
  }
}

async function ensureZbeProgress() {
  try { zbeProgress = await (await fetch("/api/zbe/progress")).json(); } catch {}
}

function renderZbeList(filter = "") {
  const ul = $("#exList");
  syncSourceSelect();
  ul.innerHTML = "";
  const f = (filter || "").trim().toLowerCase();
  for (const p of zbeList) {
    if (f && !(p.title.toLowerCase().includes(f) || p.slug.includes(f))) continue;
    const li = document.createElement("li");
    li.className = current && current.file === "zbe_" + p.slug + ".zig" ? "active" : "";
    li.innerHTML = `<span class="ex-title">${escapeHtml(p.title)}</span>${zbeProgress[p.slug] ? ' <span class="ex-mark">✅</span>' : ""}`;
    li.onclick = () => selectZbePage(p.slug);
    ul.appendChild(li);
  }
}

async function selectZbePage(slug) {
  zbeMode = true;
  const res = await (await fetch("/api/zbe/page/" + slug)).json();
  if (res.error) { addMsg("error", res.error); return; }
  zbeSnippets = res.snippets || [];
  zbeSnippetIdx = 0;
  const isTest = /test\s+"/.test(res.original || "") && !/pub fn main/.test(res.original || "");
  current = { file: "zbe_" + slug + ".zig", title: res.title, n: 0, output: "",
              hint: null, skip: false, scratch: true, original: res.original,
              uri: res.uri, rootUri: res.rootUri, slug, prose: res.prose,
              zbeTestMode: isTest, zbe: true };
  mountEditor(res.code);
  const termRefs = zbeSnippets.map((s, i) =>
    s.terminal ? `<details class="cheat"${i === 0 ? " open" : ""}><summary>🖥 运行方式 ${zbeSnippets.length > 1 ? (i + 1) : ""}</summary><pre>${escapeHtml(s.terminal)}</pre></details>` : "").join("");
  $("#lesson").innerHTML = renderMd(`### ${res.title}${"\n\n"}${"\n\n"}${res.prose}`) +
    (termRefs ? `<div style="margin-top:8px">${termRefs}</div>` : "");
  document.querySelectorAll('#lesson [data-snip]').forEach(b => {
    b.onclick = () => { zbeSnippetIdx = +b.dataset.snip; loadZbeSnippet(); };
  });
  $("#outputCard").classList.add("hidden");
  $("#runStatus").textContent = "";
  $("#btnSubmit").style.display = "none";
  $("#btnHint").style.display = "none";
  const mcb = $("#btnModeChallenge"), mpg = $("#btnModePlayground");
  if (mcb) mcb.style.display = "none";
  if (mpg) mpg.style.display = "none";
  renderZbeList($("#search").value);
  loadChatForZbe(slug);
  if (editor) editor.view.focus();
}
function loadZbeSnippet() {
  if (!zbeSnippets || !editor) return;
  const s = zbeSnippets[zbeSnippetIdx];
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s.zig } });
  saveDraft();
}
function loadChatForZbe(slug) {
  chatHistory = (JSON.parse(localStorage.getItem("chats") || "{}"))["zbe_" + slug + ".zig"] || [];
  chatLog.innerHTML = "";
  addMsg("assistant", t("zbeTutorPrefix") + "「" + current.title + "」。" + t("cookbookTutorSuffix"));
  for (const m of chatHistory) addMsg(m.role, m.content);
}


async function selectRecipe(id) {
  cookbookMode = true;
  const res = await (await fetch(`/api/cookbook/recipe/${id}?lang=${getLang() === "en" ? "en-US" : "zh-CN"}`)).json();
  if (res.error) { addMsg("error", res.error); return; }
  current = { file: "cookbook_" + id + ".zig", title: res.title, n: 0, id,
              output: "", hint: null, skip: false, scratch: true,
              original: res.original, uri: res.uri, rootUri: res.rootUri, prose: res.prose };
  mountEditor(res.code);
  let lessonHtml = renderMd(`### ${res.title}\n\n${res.prose}\n\n> Cookbook 示例：直接运行参考实现，修改后 Ctrl+Enter 立即看结果。`);
  const steps = cookbookSteps(res.id);
  if (steps) {
    lessonHtml += `\n<div class="card" style="margin:8px 0 0"><div class="card-head"><span>📋 ${t("taskCard")}</span></div>` +
      `<ol style="margin:4px 0 0; padding-left:1.4em; font-size:.86rem;">` +
      steps.map(s2 => `<li style="margin:.2em 0">${escapeHtml(s2)}</li>`).join("") + `</ol></div>`;
  }
  $("#lesson").innerHTML = lessonHtml;
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
  setupRecipeModes(id);
  if (editor) editor.view.focus();
}

/* ---------- Cookbook 双模式：挑战 ↔ Playground 随时切换 ---------- */
let recipeMode = null; // "challenge" | "playground" | null

function setRecipeButtons(challengeable) {
  const cb = $("#btnModeChallenge"), pg = $("#btnModePlayground");
  cb.style.display = challengeable ? "" : "none";
  pg.style.display = "";
  syncModeButtons();
}
function syncModeButtons() {
  const cb = $("#btnModeChallenge"), pg = $("#btnModePlayground");
  if (!cb || !pg) return;
  cb.classList.toggle("primary", recipeMode === "challenge");
  pg.classList.toggle("primary", recipeMode === "playground");
  // 提交按钮只在挑战模式显示
  $("#btnSubmit").style.display = recipeMode === "challenge" ? "" : "none";
}
function enterChallengeMode() {
  if (!current) return;
  recipeMode = "challenge";
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length,
    insert: current.skeleton || "" } });
  syncModeButtons();
  $("#btnSubmit").disabled = false;
  $("#outputCard").classList.add("hidden");
  $("#runStatus").textContent = "🎯 " + t("challengeModeOn");
  $("#runStatus").className = "";
  $("#lesson").innerHTML = renderMd(`### 🎯 ${t("challengeTitle")}：${current.title}${ESC}${ESC}${t("challengeGoal")}` +
    (current.note ? `${ESC}${ESC}📝 ${t("challengeNote")}：${current.note}` : "") +
    `${ESC}${ESC}${t("challengeHintTip")}`);
}
async function enterPlaygroundMode() {
  if (!current) return;
  recipeMode = "playground";
  // 恢复该配方的 Playground 草稿（服务端 work/runs/playground_*.zig；没有则用参考实现）
  let code = current.original || "";
  try {
    const draft = await (await fetch("/api/exercise/playground_" + current.id + ".zig")).json();
    if (draft.code && draft.code.trim()) code = draft.code;
  } catch {}
  editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: code } });
  syncModeButtons();
  $("#outputCard").classList.add("hidden");
  $("#runStatus").textContent = "🧪 " + t("playgroundStarted");
  $("#runStatus").className = "";
  $("#lesson").innerHTML = renderMd(`### 🧪 ${t("playgroundTitle")}：${current.title}${ESC}${ESC}` +
    `${draft ? t("playgroundDraftRestored") : t("playgroundRefLoaded")}${ESC}${ESC}${t("playgroundFreeTip")}`);
}
function setupRecipeModes(id) {
  recipeMode = null;
  let cb = $("#btnModeChallenge"), pg = $("#btnModePlayground");
  if (!cb) {
    cb = document.createElement("button");
    cb.id = "btnModeChallenge";
    pg = document.createElement("button");
    pg.id = "btnModePlayground";
    $("#runRow").insertBefore(pg, $("#btnExplain"));
    $("#runRow").insertBefore(cb, pg);
  }
  cb.textContent = "🎯 " + t("challengeMode");
  pg.textContent = "🧪 Playground";
  cb.style.display = ""; pg.style.display = "";
  cb.disabled = true; pg.disabled = true;
  cb.title = ""; pg.title = "";
  (async () => {
    try {
      const info = await (await fetch(`/api/cookbook/challenge/${id}?lang=${getLang() === "en" ? "en-US" : "zh-CN"}`)).json();
      current.expected = info.expected;
      current.skeleton = info.skeleton;
      current.note = info.note;
      cb.disabled = false; pg.disabled = false;
      if (info.challengeable) {
        cb.onclick = () => enterChallengeMode();
        cb.title = t("challengeTip");
        pg.onclick = () => enterPlaygroundMode();
        pg.title = t("playgroundTip");
        enterChallengeMode(); // 默认进入挑战模式
      } else {
        cb.onclick = () => {
          cb.title = t("notJudgeable");
          cb.classList.add("shake");
          setTimeout(() => cb.classList.remove("shake"), 500);
        };
        cb.title = t("notJudgeable");
        pg.onclick = () => enterPlaygroundMode();
        pg.title = t("playgroundTip");
        enterPlaygroundMode(); // 不可判题：默认 Playground
      }
    } catch (e) {
      cb.disabled = true;
      pg.disabled = false;
      pg.onclick = () => enterPlaygroundMode();
      enterPlaygroundMode();
    }
  })();
}

/* 挑战模式 / Playground 按钮（按可判题性动态生成） */
async function submitChallenge() {
  $("#runStatus").textContent = t("submitting"); $("#runStatus").className = "";
  const res = await (await fetch("/api/cookbook/judge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: current.id, code: code(), lang: getLang() === "en" ? "en-US" : "zh-CN" })
  })).json();
  lastResult = res;
  $("#outputCard").classList.remove("hidden");
  const out = $("#output");
  if (res.error) {
    $("#runStatus").textContent = "⚠ " + res.error.slice(0, 60);
    $("#runStatus").className = "err";
    out.innerHTML = `<span class="err">${escapeHtml(res.error)}</span>`;
    return;
  }
  if (res.passed) {
    $("#runStatus").textContent = "🎯 " + t("challengePassed");
    $("#runStatus").className = "ok";
    out.innerHTML = `<span class="ok">${escapeHtml(res.outputSeen)}</span>${ESC}${ESC}<span class="ok">🎉 ${t("challengePassedMsg")}</span>`;
    markCookbookDone(current.id, true);
  } else {
    $("#runStatus").textContent = t("outputMismatch");
    $("#runStatus").className = "err";
    let hintHtml = "";
    const h = res.hints;
    if (h && ((h.signatures && h.signatures.length) || (h.stdSymbols && h.stdSymbols.length))) {
      const items = [
        ...(h.signatures || []).map(s2 => `签名：${s2}`),
        ...(h.stdSymbols || []).map(s2 => `可能用到的 API：${s2}`),
      ];
      hintHtml = `<details class="cheat" style="margin-top:8px"><summary>💡 ${t("progressiveHint")}</summary>` +
        items.map(x => `<div>· ${escapeHtml(x)}</div>`).join("") + `</details>`;
    }
    out.innerHTML =
      (res.stderr ? `<span class="err">${escapeHtml(res.stderr)}</span>${ESC}` : "") +
      `<span class="exp">${escapeHtml(t("expected"))}${escapeHtml(res.expected)}</span>${ESC}` +
      `<span>${escapeHtml(t("actual"))}${escapeHtml(res.outputSeen || res.stdout || "(空)")}</span>` +
      hintHtml;
  }
  out.scrollTop = 0;
}
function renderListSearchSafe() {
  if (cookbookMode) renderCookbookList(); else renderList($("#search").value);
}

const CHAPTER_STEPS = {
  "04": ["运行 TCP 服务器，记下输出里的监听端口", "把 TCP 客户端的端口改成同样的值（或填进程序参数框）", "运行客户端，观察两边的收发日志", "进阶：把服务器改成支持多客户端（配合 07 线程章节）"],
  "05": ["运行 HTTP 示例，观察请求/输出", "修改 URL 或请求体再运行", "进阶：给服务端加一个自定义响应头"],
  "14": ["该章需要本地 C 库与数据库服务（参考上游 docker-compose.yml）", "若环境不具备，阅读代码学习 API 用法"],
  "07": ["运行示例观察线程交错输出", "多次运行，观察结果可能不同", "进阶：调整线程数量或共享数据方式再观察"],
  "08": ["运行示例观察输出", "对比你机器的逻辑 CPU 数量"],
};
function cookbookSteps(id) {
  return CHAPTER_STEPS[id.slice(0, 2)] || null;
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
  chatHistory = (JSON.parse(localStorage.getItem("chats") || "{}"))["cookbook_" + id + ".zig"] || [];
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
$("#btnDocs").onclick = () => {
  document.body.classList.remove("dock-hidden");   // 面板收起时先展开
  localStorage.setItem("dockHidden", "0");
  document.querySelector('.tab[data-tab="ref"]').click();
  if (editor) editor.view.requestMeasure();
};
$("#btnLang").onclick = () => {
  setLang(getLang() === "en" ? "zh" : "en");
  location.reload();
};

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

let docTr = null; // {map:Map, target, observer}

function stopDocTranslateSession() {
  if (docTr && docTr.observer) docTr.observer.disconnect();
  docTr = null;
  const btn = $("#btnDocTranslate");
  btn.textContent = t("docTranslate");
}

function applyDocTranslations(root, map) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  const hits = [];
  while ((n = walker.nextNode())) {
    const v = n.nodeValue.trim();
    if (v.length > 1 && map.has(v)) hits.push(n);
  }
  for (const n of hits) {
    const tr = map.get(n.nodeValue.trim());
    if (tr) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), tr);
  }
}

$("#btnDocTranslate").onclick = async () => {
  const btn = $("#btnDocTranslate");
  if (docTr) { stopDocTranslateSession(); return; }
  if (!docFrame.src.includes("/p/ziglang.org/")) { loadDoc($("#docPreset").value); return; }
  const doc = docFrame.contentDocument;
  if (!doc || !doc.body) return;
  const skip = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "KBD"]);
  const blocks = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,summary,figcaption,blockquote,a,span,label,button,div")]
    .filter(el => !skip.has(el.tagName) &&
                  [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim().length > 1));
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
  if (!nodes.length) {
    btn.textContent = "⚠ " + t("noTranslatable");
    setTimeout(() => btn.textContent = t("docTranslate"), 2500);
    return;
  }
  const uniq = [...new Set(nodes.map(n => n.nodeValue.trim()))];
  const target = "zh";
  const map = new Map();
  docTr = { map, target, observer: null };
  btn.disabled = true;
  for (let i = 0; i < uniq.length; i += 30) {
    const batch = uniq.slice(i, i + 30);
    let size = 0; const sub = [];
    for (const t of batch) { if (size + t.length > 3000 && sub.length) break; size += t.length; sub.push(t); }
    btn.textContent = `⏳ ${t("translating")} ${Math.min(i + sub.length, uniq.length)}/${uniq.length}`;
    try {
      const res = await (await fetch("/api/translate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: sub, target })
      })).json();
      if (res.translations) sub.forEach((orig, k2) => {
        const tr = res.translations[k2];
        if (tr && !String(tr).startsWith("{")) map.set(orig, tr);
      });
      applyDocTranslations(doc.body, map);  // 每批即时应用，边翻边显示
    } catch (e) { /* 单批失败保留原文 */ }
  }
  // SPA 重渲染监视：新增文本命中缓存即重套译文
  const mo = new doc.defaultView.MutationObserver((muts) => {
    for (const mu of muts) {
      for (const n of mu.addedNodes) {
        if (n.nodeType === 1 && n.querySelectorAll) {
          for (const tn of n.querySelectorAll("*")) {
            for (const c of tn.childNodes) {
              if (c.nodeType === 3) {
                const v = c.nodeValue.trim();
                if (v.length > 1 && docTr && docTr.map.has(v) && c.nodeValue.includes(v)) {
                  c.nodeValue = c.nodeValue.replace(v, docTr.map.get(v));
                }
              }
            }
          }
        }
      }
    }
  });
  mo.observe(doc.body, { childList: true, subtree: true });
  docTr.observer = mo;
  btn.disabled = false;
  btn.textContent = "✓ " + t("translated") + `（${map.size} 段）`;
};

/* cookbook 完成打勾 *//* cookbook 完成打勾 */
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
