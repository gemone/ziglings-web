#!/usr/bin/env python3
"""
Ziglings Web — local server.

Serves the web UI from ./web and provides:
  GET  /api/exercises              -> exercise metadata + progress
  GET  /api/exercise/<file>        -> exercise source code
  POST /api/run                    -> {file, code} compile+run, check expected output
  POST /api/solution/<file>        -> save user's code for an exercise
  GET  /api/config, POST /api/config  -> AI provider settings (stored locally in ai_config.json)
  POST /api/chat                   -> proxy to an OpenAI-compatible chat API
Run:  python3 server.py  (http://127.0.0.1:8123)
"""
import json
import os
import re
import subprocess
import threading
import time
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from lsp_bridge import LspBridge

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
WORK = os.path.join(ROOT, "work", "runs")
DATA = os.path.join(ROOT, "web", "data", "exercises.json")
PROGRESS = os.path.join(ROOT, "work", "progress.json")
AI_CONFIG = os.path.join(ROOT, "work", "ai_config.json")
SUBMISSIONS = os.path.join(ROOT, "work", "submissions.json")
APP_CONFIG = os.path.join(ROOT, "work", "config.json")
UPSTREAM = "https://codeberg.org/ziglings/exercises.git"
ZIGLINGS = os.path.join(ROOT, "ziglings")
DEFAULT_ZIG = os.environ.get("ZIG_EXE", "zig")
RUN_TIMEOUT = 30
ZVM_DIR = os.path.expanduser("~/.zvm")


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)


def list_zigs():
    """Installed zig toolchains: zvm versions + whatever `zig` is on PATH."""
    found = {}
    try:
        if os.path.isdir(ZVM_DIR):
            for d in os.listdir(ZVM_DIR):
                exe = os.path.join(ZVM_DIR, d, "bin", "zig")
                if re.fullmatch(r"\d+\.\d+\.\d+", d) and os.path.isfile(exe):
                    found[d] = exe
    except OSError:
        pass
    try:
        p = subprocess.run([DEFAULT_ZIG, "version"], capture_output=True, text=True, timeout=15)
        v = p.stdout.strip()
        if v and v not in found:
            found[v] = DEFAULT_ZIG
    except Exception:
        pass
    return [{"version": v, "path": p} for v, p in sorted(found.items(),
            key=lambda kv: [int(x) for x in kv[0].split(".")], reverse=True)]


def selected_zig_version():
    return load_json(APP_CONFIG, {}).get("zigVersion")


def zig_exe():
    """The zig binary for the selected version (fallback: default)."""
    want = selected_zig_version()
    if want:
        for z in list_zigs():
            if z["version"] == want:
                return z["path"]
    return DEFAULT_ZIG


def ziglings_tag_for(version):
    """Map a zig version to the matching upstream ziglings tag (v<maj>.<min>.*)."""
    try:
        subprocess.run(["git", "fetch", "--tags", "--force", "--depth", "1", UPSTREAM],
                       cwd=ZIGLINGS, capture_output=True, timeout=300)
        out = subprocess.run(["git", "tag", "-l", f"v{version.rsplit('.', 1)[0]}.*"],
                             cwd=ZIGLINGS, capture_output=True, text=True, timeout=30).stdout.split()
        if out:
            return sorted(out)[-1]  # highest patch of matching major.minor
    except Exception:
        pass
    return None


def apply_zig_version(version):
    """切换 zig 版本：保存配置 → ziglings 切到对应 tag → 重提元数据 → 更新 zls 配置。"""
    zigs = {z["version"]: z["path"] for z in list_zigs()}
    if version not in zigs:
        return False, f"未安装 zig {version}"
    cfg = load_json(APP_CONFIG, {})
    cfg["zigVersion"] = version
    save_json(APP_CONFIG, cfg)
    # 1) ziglings 切换到对应版本的 tag（默认分支仅当无匹配 tag 时）
    tag = ziglings_tag_for(version)
    try:
        if tag:
            subprocess.run(["git", "checkout", "-f", tag], cwd=ZIGLINGS,
                           capture_output=True, timeout=60)
        else:
            subprocess.run(["git", "checkout", "-f", "main"], cwd=ZIGLINGS,
                           capture_output=True, timeout=60)
    except Exception as e:
        print(f"[zig] ziglings checkout failed: {e}")
    # 2) 重新提取该版本题库的元数据
    try:
        subprocess.run(["python3", os.path.join(ROOT, "tools", "extract_exercises.py")],
                       check=True, capture_output=True, timeout=60)
    except Exception as e:
        print(f"[zig] re-extract failed: {e}")
    # 3) 更新 zls 配置指向该 zig（zls 版本需与 zig 一致才能完全工作）
    zls_json = os.path.join(WORK, "zls.json")
    zcfg = load_json(zls_json, {})
    exe = zigs[version]
    zcfg["zig_exe_path"] = exe
    zcfg["zig_lib_path"] = os.path.join(os.path.dirname(exe), "lib")
    save_json(zls_json, zcfg)
    return True, tag or "main"

os.makedirs(WORK, exist_ok=True)
os.makedirs(os.path.join(ROOT, ".zigcache"), exist_ok=True)

_lock = threading.Lock()


ZIG_ENV = {
    **os.environ,
    "ZIG_GLOBAL_CACHE_DIR": os.path.join(ROOT, ".zigcache", "global"),
    "ZIG_LOCAL_CACHE_DIR": os.path.join(ROOT, ".zigcache", "local"),
}

EXERCISES = load_json(DATA, [])
BY_FILE = {e["file"]: e for e in EXERCISES}


def zig_lint(file, code):
    """Syntax/AST diagnostics via `zig ast-check`. Returns CM-compatible list."""
    path = os.path.join(WORK, file)
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
        try:
            p = subprocess.run([zig_exe(), "ast-check", path],
                               capture_output=True, text=True, timeout=15, env=ZIG_ENV)
        except subprocess.TimeoutExpired:
            return []
    diags = []
    for m in re.finditer(r"[^:\n]+\.zig:(\d+):(\d+):\s*error:\s*(.+)", p.stderr):
        line, col, msg = int(m.group(1)), int(m.group(2)), m.group(3).strip()
        diags.append({"line": line - 1, "col": col - 1, "message": msg})
    return diags


def normalize(s: str) -> str:
    lines = [ln.rstrip() for ln in s.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def check_output(ex, p):
    raw = p.stdout if ex.get("check_stdout") else p.stderr
    got = normalize(raw)
    expected = normalize(ex["output"])
    if ex.get("timestamp"):
        # mask the timestamp digits (both are at columns 14..24 of the line)
        def mask(t):
            lines = t.split("\n")
            out = []
            for ln in lines:
                if len(ln) >= 24:
                    ln = ln[:14] + "#" * 10 + ln[24:]
                out.append(ln)
            return "\n".join(out)
        return mask(got) == mask(expected)
    return got == expected, got


def run_exercise(ex, code):
    path = os.path.join(WORK, ex["file"])
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
        cmd = [zig_exe(), "run", path]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=RUN_TIMEOUT, env=ZIG_ENV, cwd=ROOT)
        except subprocess.TimeoutExpired:
            return {"passed": False, "timeout": True,
                    "stderr": f"Timed out after {RUN_TIMEOUT}s."}
    passed, got = False, p.stdout
    try:
        passed, got = check_output(ex, p)
    except Exception:
        pass
    if not passed and p.returncode != 0:
        passed = False
    return {"passed": passed, "returncode": p.returncode,
            "stdout": p.stdout, "stderr": p.stderr, "outputSeen": got,
            "expected": ex["output"]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path.startswith("/p/ziglang.org/"):
            return self._proxy_subtree()
        if self.path.startswith("/proxy?url="):
            return self._proxy()
        if self.path == "/lsp" and self.headers.get("Upgrade", "").lower() == "websocket":
            bridge = LspBridge(self)
            bridge.handshake()
            bridge.start()
            self.close_connection = True
            return
        if self.path == "/api/exercises":
            progress = load_json(PROGRESS, {})
            out = []
            for e in EXERCISES:
                code = self._user_code(e["file"])
                out.append({**e, "done": bool(progress.get(e["file"])),
                            "hasCode": code is not None})
            return self._send(200, json.dumps(out))
        if self.path.startswith("/api/exercise/"):
            f = os.path.basename(self.path)
            if f == SCRATCH_FILE:
                code = self._user_code(f) or SCRATCH_TEMPLATE
                return self._send(200, json.dumps({
                    "file": f, "code": code, "original": SCRATCH_TEMPLATE,
                    "uri": "file://" + os.path.join(WORK, f),
                    "rootUri": "file://" + WORK, "scratch": True,
                }))
            code = self._user_code(f) or self._orig_code(f)
            if code is None:
                return self._send(404, json.dumps({"error": "not found"}))
            return self._send(200, json.dumps({
                "file": f, "code": code, "original": self._orig_code(f),
                "uri": "file://" + os.path.join(WORK, f),
                "rootUri": "file://" + WORK,
            }))
        if self.path == "/api/env":
            return self._send(200, json.dumps({
                "zigs": list_zigs(),
                "selected": selected_zig_version(),
                "current": zig_exe(),
            }))
        if self.path == "/api/config":
            cfg = load_json(AI_CONFIG, {})
            cfg = {**cfg, "apiKeySet": bool(cfg.get("apiKey"))}
            cfg.pop("apiKey", None)
            return self._send(200, json.dumps(cfg))
        return self._static()

    def _orig_code(self, f):
        p = os.path.join(ROOT, "ziglings", "exercises", f)
        if os.path.isfile(p):
            return open(p, encoding="utf-8").read()
        return None

    def _user_code(self, f):
        p = os.path.join(WORK, f)
        if os.path.isfile(p):
            return open(p, encoding="utf-8").read()
        return None

    def _static(self):
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not fp.startswith(WEB) or not os.path.isfile(fp):
            return self._send(404, "not found", "text/plain")
        ctype = {"html": "text/html", "js": "text/javascript",
                 "css": "text/css", "json": "application/json",
                 "svg": "image/svg+xml", "png": "image/png"}.get(
                     fp.rsplit(".", 1)[-1], "application/octet-stream")
        with open(fp, "rb") as fh:
            return self._send(200, fh.read(), ctype)

    def do_POST(self):
        global EXERCISES, BY_FILE
        if self.path == "/api/run":
            b = self._json_body()
            f = b.get("file") or ""
            if f == SCRATCH_FILE:
                return self._send(200, json.dumps(run_scratch(b.get("code") or "")))
            ex = BY_FILE.get(f)
            if not ex:
                return self._send(400, json.dumps({"error": "unknown exercise"}))
            res = run_exercise(ex, b.get("code") or "")
            return self._send(200, json.dumps(res))
        if self.path.startswith("/api/solution/"):
            f = os.path.basename(self.path)
            if f not in BY_FILE:
                return self._send(400, json.dumps({"error": "unknown exercise"}))
            b = self._json_body()
            with open(os.path.join(WORK, f), "w", encoding="utf-8") as fh:
                fh.write(b.get("code") or "")
            return self._send(200, json.dumps({"saved": True}))
        if self.path == "/api/config":
            b = self._json_body()
            cfg = load_json(AI_CONFIG, {})
            for k in ("baseUrl", "model"):
                if k in b:
                    cfg[k] = b[k].rstrip("/")
            if b.get("apiKey"):
                cfg["apiKey"] = b["apiKey"]
            save_json(AI_CONFIG, cfg)
            return self._send(200, json.dumps({"saved": True}))
        if self.path == "/api/submit":
            b = self._json_body()
            ex = BY_FILE.get(b.get("file") or "")
            if not ex:
                return self._send(400, json.dumps({"error": "unknown exercise"}))
            res = run_exercise(ex, b.get("code") or "")
            entry = {"file": ex["file"], "time": int(time.time()),
                     "passed": res["passed"], "code": b.get("code") or ""}
            subs = load_json(SUBMISSIONS, [])
            subs.append(entry)
            save_json(SUBMISSIONS, subs)
            if res["passed"]:
                progress = load_json(PROGRESS, {})
                progress[ex["file"]] = True
                save_json(PROGRESS, progress)
            return self._send(200, json.dumps({**res, "submission": True,
                "attempts": sum(1 for s in subs if s["file"] == ex["file"])}))
        if self.path == "/api/lint":
            b = self._json_body()
            f = b.get("file") or ""
            if f not in BY_FILE:
                return self._send(400, json.dumps({"error": "unknown exercise"}))
            return self._send(200, json.dumps({"diagnostics": zig_lint(f, b.get("code") or "")}))
        if self.path == "/api/env/select":
            b = self._json_body()
            ok, info = apply_zig_version(b.get("version") or "")
            # 元数据变了，重新加载题库
            EXERCISES = load_json(DATA, [])
            BY_FILE = {e["file"]: e for e in EXERCISES}
            return self._send(200, json.dumps({"ok": ok, "ziglings": info} if ok
                                              else {"error": info}))
        if self.path == "/api/translate":
            b = self._json_body()
            texts = b.get("texts") or []
            target = b.get("target") or ("en" if (load_json(AI_CONFIG, {}).get("lang") == "en") else "zh")
            if not texts:
                return self._send(200, json.dumps({"translations": []}))
            return self._send(200, json.dumps(self._translate(texts, target)))
        if self.path == "/api/chat":
            return self._chat()
        return self._send(404, json.dumps({"error": "not found"}))



    def _proxy_subtree(self):
        """路径式同源代理：/p/ziglang.org/<path> -> https://ziglang.org/<path>
        相对路径的子资源(wasm/js/tar)会自动落回本代理，无需改写。"""
        import urllib.parse
        parsed = urllib.parse.urlparse(self.path)
        rest = parsed.path[len("/p/ziglang.org/"):]
        url = "https://ziglang.org/" + rest
        if parsed.query:
            url += "?" + parsed.query
        print("[proxy]", url, file=sys.stderr, flush=True)
        req_headers = {"User-Agent": "Mozilla/5.0"}
        body = ctype = None
        last_err = None
        for attempt in range(3):  # 网络抖动重试
            req = urllib.request.Request(url, headers=req_headers)
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    ctype = r.headers.get("Content-Type", "application/octet-stream")
                    body = r.read()
                break
            except Exception as e:
                last_err = e
                time.sleep(0.5 * (attempt + 1))
        if body is None:
            return self._send(502, f"fetch failed after retries: {last_err}", "text/plain")
        if "text/html" in ctype:
            html = body.decode("utf-8", "replace")
            # base 指向本代理的对应目录：根相对路径(/x)也走代理
            i = rest.rfind("/")
            dir_part = rest[:i + 1]
            base_tag = f'<base href="/p/ziglang.org/{dir_part}">'
            if "<head" in html:
                html = re.sub(r"(<head[^>]*>)", r"\1" + base_tag, html, count=1)
            else:
                html = base_tag + html
            body = html.encode("utf-8")
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    ALLOWED_DOC_HOSTS = ("ziglang.org", "www.ziglang.org")

    def _proxy(self):
        """同源代理文档页面：使 iframe 内容可被前端读取/翻译。仅允许白名单域名。"""
        import urllib.parse
        qs = urllib.parse.urlparse(self.path).query
        url = urllib.parse.parse_qs(qs).get("url", [""])[0]
        u = urllib.parse.urlparse(url)
        if u.scheme != "https" or u.hostname not in self.ALLOWED_DOC_HOSTS:
            return self._send(400, json.dumps({"error": "domain not allowed"}), "text/plain")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                ctype = r.headers.get("Content-Type", "text/html")
                body = r.read()
        except Exception as e:
            return self._send(502, str(e), "text/plain")
        if "text/html" in ctype:
            html = body.decode("utf-8", "replace")
            base = f'{u.scheme}://{u.hostname}/'
            base_tag = f'<base href="{base}">'
            if "<head" in html:
                html = re.sub(r"(<head[^>]*>)", r"\1" + base_tag, html, count=1)
            else:
                html = base_tag + html
            body = html.encode("utf-8")
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


    def _translate(self, texts, target):
        cfg = load_json(AI_CONFIG, {})
        base, key, model = cfg.get("baseUrl"), cfg.get("apiKey"), cfg.get("model", "gpt-4o-mini")
        if not base or not key:
            return {"error": "AI 未配置：请先在 ⚙ 设置里填写 OpenAI 兼容接口。"}
        lang_name = "English" if target == "en" else "简体中文"
        sep = "\n@@@\n"
        out = []
        # 分批，每批 ≤ 3500 字符
        batch, size = [], 0
        for t in texts:
            batch.append(t)
            size += len(t)
            if size > 3500:
                out.extend(self._translate_batch(batch, sep, lang_name, base, key, model))
                batch, size = [], 0
        if batch:
            out.extend(self._translate_batch(batch, sep, lang_name, base, key, model))
        return {"translations": out}

    def _translate_batch(self, batch, sep, lang_name, base, key, model):
        prompt = (f"Translate each segment below to {lang_name}. These are segments from "
                  f"programming language documentation; keep technical terms, identifiers and "
                  f"code names untranslated. Return EXACTLY {len(batch)} segments separated by "
                  f"the line {sep.strip()} , in the same order, with no extra commentary.")
        body = json.dumps({
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a precise technical documentation translator."},
                {"role": "user", "content": prompt + "\n\n" + sep.join(batch)},
            ],
            "temperature": 0,
        }).encode()
        req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.load(r)
            content = data["choices"][0]["message"]["content"]
            parts = [p.strip() for p in content.split(sep.strip())]
            if len(parts) == len(batch):
                return parts
            return parts + batch[len(parts):]  # 数量不符时回退原文
        except Exception as e:
            return {"error": f"translate failed: {e}"}

    def _chat(self):
        b = self._json_body()
        cfg = load_json(AI_CONFIG, {})
        base, key, model = cfg.get("baseUrl"), cfg.get("apiKey"), cfg.get("model", "gpt-4o-mini")
        if not base or not key:
            return self._send(400, json.dumps({"error":
                "AI 未配置：请在右上角 ⚙ 设置里填写 OpenAI 兼容的 Base URL / API Key / 模型名。"}))
        req = urllib.request.Request(
            base + "/chat/completions",
            data=json.dumps({"model": model, "messages": b.get("messages", []),
                             "stream": False}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)
            msg = data["choices"][0]["message"]
            return self._send(200, json.dumps({"reply": msg.get("content", "")}))
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            return self._send(502, json.dumps({"error": f"上游 API 错误 {e.code}: {detail}"}))
        except Exception as e:
            return self._send(502, json.dumps({"error": f"请求失败: {e}"}))


SCRATCH_FILE = "scratch.zig"
SCRATCH_TEMPLATE = """const std = @import("std");

pub fn main() void {
    // 实验场：随便写，Ctrl+Enter 立即运行，代码自动保存
    std.debug.print("hello, scratch!\n", .{});
}
"""


def run_scratch(code):
    """自由实验：编译+运行，不判题，退出码 0 即通过。"""
    path = os.path.join(WORK, SCRATCH_FILE)
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
        try:
            p = subprocess.run([zig_exe(), "run", path], capture_output=True,
                               text=True, timeout=RUN_TIMEOUT, env=ZIG_ENV, cwd=ROOT)
        except subprocess.TimeoutExpired:
            return {"passed": False, "timeout": True, "returncode": -1,
                    "stdout": "", "stderr": f"Timed out after {RUN_TIMEOUT}s.",
                    "outputSeen": "", "expected": "", "scratch": True}
    return {"passed": p.returncode == 0, "returncode": p.returncode,
            "stdout": p.stdout, "stderr": p.stderr,
            "outputSeen": (p.stdout + p.stderr).strip(),
            "expected": "", "scratch": True}


def init_content():
    """拉取上游 ziglings 仓库并生成练习元数据（缺什么补什么）。"""
    import subprocess
    if not os.path.isdir(os.path.join(ZIGLINGS, ".git")):
        print(f"[init] cloning ziglings from {UPSTREAM} ...")
        try:
            subprocess.run(["git", "clone", "--depth", "1", UPSTREAM, ZIGLINGS],
                           check=True, timeout=300)
        except Exception as e:
            print(f"[init] clone failed: {e}（可手动执行 tools/sync.sh）")
            return
    if not os.path.exists(DATA):
        print("[init] extracting exercise metadata ...")
        try:
            subprocess.run(["python3", os.path.join(ROOT, "tools", "extract_exercises.py")],
                           check=True, timeout=60)
        except Exception as e:
            print(f"[init] extract failed: {e}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8123"))
    if os.environ.get("NO_SYNC") != "1":
        init_content()
        # 已配置过 zig 版本的话，启动时把 ziglings 切到对应 tag
        if selected_zig_version():
            ok, info = apply_zig_version(selected_zig_version())
            print(f"[init] zig {selected_zig_version()} -> ziglings {info}")
    print(f"Ziglings Web -> http://127.0.0.1:{port}  (zig: {zig_exe()})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
