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
import cookbook
import zigbyexample

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
    """切换 zig 版本：checkout 对应 tag → 重提元数据 → 全部成功才持久化配置。

    任一步失败即返回错误并保持原状态（不会出现"新版本标签 + 旧元数据"的错位）。
    """
    zigs = {z["version"]: z["path"] for z in list_zigs()}
    if version not in zigs:
        return False, f"未安装 zig {version}"
    # 0) 记录旧版本的 tag，失败时回滚 checkout
    prev_version = selected_zig_version()
    # 1) ziglings 切换到对应版本的 tag（默认分支仅当无匹配 tag 时）
    tag = ziglings_tag_for(version)
    target = tag or "main"
    try:
        cp = subprocess.run(["git", "checkout", "-f", target], cwd=ZIGLINGS,
                            capture_output=True, timeout=60)
        if cp.returncode != 0:
            return False, f"checkout {target} 失败: {cp.stderr.decode(errors='replace')[:200]}"
    except Exception as e:
        return False, f"checkout 异常: {e}"
    # 2) 重新提取该版本题库的元数据（必须成功；失败则回滚到旧 tag）
    try:
        cp = subprocess.run(["python3", os.path.join(ROOT, "tools", "extract_exercises.py")],
                            capture_output=True, timeout=120)
        if cp.returncode != 0:
            prev_tag = ziglings_tag_for(prev_version) if prev_version else None
            rollback_target = prev_tag or "main"
            subprocess.run(["git", "checkout", "-f", rollback_target], cwd=ZIGLINGS,
                           capture_output=True, timeout=60)
            return False, (f"重新提取元数据失败（已回滚到 {rollback_target}）: "
                           + cp.stderr.decode(errors="replace")[:200])
    except Exception as e:
        prev_tag = ziglings_tag_for(prev_version) if prev_version else None
        subprocess.run(["git", "checkout", "-f", prev_tag or "main"], cwd=ZIGLINGS,
                       capture_output=True, timeout=60)
        return False, f"重提元数据异常（已回滚到 {prev_tag or 'main'}）: {e}"
    # 3) 全部成功才持久化配置
    cfg = load_json(APP_CONFIG, {})
    cfg["zigVersion"] = version
    save_json(APP_CONFIG, cfg)
    # 4) 更新 zls 配置指向该 zig（zls 版本需与 zig 一致才能完全工作）
    try:
        zls_json = os.path.join(ROOT, "work", "zls.json")
        zcfg = load_json(zls_json, {})
        exe = zigs[version]
        zcfg["zig_exe_path"] = exe
        zcfg["zig_lib_path"] = os.path.join(os.path.dirname(exe), "lib")
        save_json(zls_json, zcfg)
    except OSError:
        pass  # zls 配置写失败不影响主流程
    return True, target

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
        # 与上游 elrond 一致：把实际输出第 14..24 列的数字代入期望占位符重建后比较
        #（占位符 <timestamp> 为 11 字符，时间戳数字为 10 位）
        lines = got.split("\n")
        if len(lines) >= 1 and len(lines[0]) >= 24:
            rebuilt = expected[:14] + lines[0][14:24] + expected[25:]
            return (normalize(rebuilt) == got), got
        return False, got
    return got == expected, got


def run_exercise(ex, code):
    path = os.path.join(WORK, ex["file"])
    # link_libc 练习涉及 C 编译与链接，首次耗时远超普通练习
    timeout = 150 if ex.get("link_libc") else RUN_TIMEOUT
    # 测试式练习（含 test 块且无 main）：用 zig test 运行，全部通过即判过
    is_test = re.search(r'\btest\s+"', code) and not re.search(r"pub\s+fn\s+main", code)
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
        libc = ["-lc"] if ex.get("link_libc") else []
        if is_test:
            cmd = [zig_exe(), "test", *libc, path]
        else:
            cmd = [zig_exe(), "run", *libc, path]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=timeout, env=ZIG_ENV, cwd=ROOT)
        except subprocess.TimeoutExpired:
            return {"passed": False, "timeout": True,
                    "stderr": f"Timed out after {timeout}s."}
    if is_test:
        # zig test 成功时输出 "All N tests passed."
        return {"passed": p.returncode == 0, "returncode": p.returncode,
                "stdout": p.stdout, "stderr": p.stderr,
                "outputSeen": (p.stdout + p.stderr).strip(), "expected": ex.get("output", ""),
                "testMode": True}
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
                             "stream": True}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key,
                     "Accept": "text/event-stream"})
        # 流式透传：上游开始吐字后不会再读超时；首字节前的等待上限 180s。
        # 上游偶发 5xx/限流：重试 3 次（首字节失败才重试，流开始后不重试）
        up = None
        last_err = None
        for attempt in range(3):
            try:
                up = urllib.request.urlopen(req, timeout=180)
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300]
                last_err = f"上游 API 错误 {e.code}: {detail}"
                if e.code < 500 and e.code != 429:
                    break  # 4xx（除限流）不重试
            except Exception as e:
                last_err = f"请求失败: {e}"
            time.sleep(1.0 * (attempt + 1))
        if up is None:
            return self._send(502, json.dumps({"error": last_err + "（已重试 3 次；若持续失败请检查接口额度/状态）"}))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            for raw in up:
                line = raw.strip()
                if not line:
                    continue
                self.wfile.write(line + b"\n\n")
                self.wfile.flush()
        except Exception as e:
            try:  # 中途断流时把错误推给前端再结束
                self.wfile.write(b'data: {"error": "stream broken"}\n\n')
                self.wfile.flush()
            except Exception:
                pass
        finally:
            up.close()


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
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return {}

    def do_GET(self):
        if not self.path.startswith(("/proxy?url=", "/p/", "/api/cookbook")) and "?" in self.path:
            self.path = self.path.split("?", 1)[0]  # 路由用纯路径（/api/cookbook 自行解析 ?lang=）
        if self.path == "/api/zbe":
            try:
                return self._send(200, json.dumps(zigbyexample.list_pages()))
            except Exception as e:
                return self._send(502, json.dumps({"error": f"拉取 zigbyexample 失败: {e}"}))
        if self.path.startswith("/api/zbe/page/"):
            slug = self.path.split("/page/")[1].split("?")[0]
            try:
                page = zigbyexample.get_page(slug)
            except Exception as e:
                return self._send(502, json.dumps({"error": f"拉取失败: {e}"}))
            code = self._user_code("zbe_" + slug + ".zig") or (page["snippets"][0]["zig"] if page["snippets"] else "")
            return self._send(200, json.dumps({
                "slug": slug, "title": page["title"], "prose": page["prose"],
                "code": code, "original": page["snippets"][0]["zig"] if page["snippets"] else "",
                "snippets": page["snippets"], "url": page["url"],
                "uri": "file://" + os.path.join(WORK, "zbe_" + slug + ".zig"),
                "rootUri": "file://" + WORK, "scratch": True,
            }))
        if self.path == "/api/zbe/progress":
            return self._send(200, json.dumps(load_json(os.path.join(ROOT, "work", "zbe_progress.json"), {})))
        if self.path.startswith("/api/runbg/status/"):
            rid = self.path.rsplit("/", 1)[1]
            ent = BGRUNS.get(rid)
            if not ent:
                return self._send(404, json.dumps({"error": "no such run"}))
            with ent["lock"]:
                output = "".join(ent["out"])
            return self._send(200, json.dumps({
                "running": not ent["done"], "returncode": ent["rc"], "output": output,
                "file": ent["file"],
            }))
        if self.path.startswith("/api/runbg/stop/"):
            rid = self.path.rsplit("/", 1)[1]
            ent = BGRUNS.get(rid)
            if ent and ent["p"] and ent["p"].poll() is None:
                ent["p"].kill()
            return self._send(200, json.dumps({"ok": True}))
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
        if self.path.startswith("/api/exercise/playground_"):
            f = os.path.basename(self.path)
            code = self._user_code(f) or ""
            return self._send(200, json.dumps({
                "file": f, "code": code, "original": "",
                "uri": "file://" + os.path.join(WORK, f),
                "rootUri": "file://" + WORK, "scratch": True,
            }))
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
        if self.path.split("?")[0] == "/api/cookbook":
            from urllib.parse import urlparse, parse_qs
            lang = "en-US" if "en" in (parse_qs(urlparse(self.path).query).get("lang") or ["zh"]) else "zh-CN"
            try:
                recipes = cookbook.list_recipes(lang)
                if not recipes and lang != "zh-CN":
                    recipes = cookbook.list_recipes("zh-CN")  # 目标语言拉取失败时回退中文
                return self._send(200, json.dumps(recipes))
            except Exception as e:
                return self._send(502, json.dumps({"error": f"拉取 cookbook 失败: {e}"}))
        if self.path.startswith("/api/cookbook/recipe/"):
            from urllib.parse import urlparse, parse_qs
            rid = self.path.split("/recipe/")[1].split("?")[0]
            q = parse_qs(urlparse(self.path).query)
            lang = "en-US" if "en" in (q.get("lang") or ["zh"]) else "zh-CN"
            try:
                r = cookbook.get_recipe(rid, lang)
            except Exception as e:
                return self._send(502, json.dumps({"error": f"拉取失败: {e}"}))
            code = self._user_code("cookbook_" + rid + ".zig") or r["code"]
            return self._send(200, json.dumps({
                "id": rid, "title": r["title"], "prose": r["prose"],
                "code": code, "original": r["code"],
                "uri": "file://" + os.path.join(WORK, "cookbook_" + rid + ".zig"),
                "rootUri": "file://" + WORK, "scratch": True,
            }))
        if self.path.startswith("/api/cookbook/challenge/"):
            from urllib.parse import urlparse, parse_qs
            rid = self.path.split("/challenge/")[1].split("?")[0]
            q = parse_qs(urlparse(self.path).query)
            lang = "en-US" if "en" in (q.get("lang") or ["zh"]) else "zh-CN"
            if not re.fullmatch(r"[a-z0-9-]+(?:__[a-z0-9-]+)*", rid):
                return self._send(400, json.dumps({"error": "bad id"}))
            has_override = bool(rid in OVERRIDES and OVERRIDES[rid].get("code"))
            challengeable = has_override  # 判题资格由覆盖层决定（需可判题的输出变体）
            expected = None
            note = None
            hints = None
            try:
                r = cookbook.get_recipe(rid, lang)
                ref_code = cookbook_code_for(rid, r["code"])
                if has_override:
                    note = OVERRIDES[rid].get("note")
                if challengeable:
                    expected = _cookbook_expected(rid, ref_code)
                    hints = cookbook_hints(ref_code)
            except Exception as e:
                return self._send(502, json.dumps({"error": f"拉取失败: {e}"}))
            if expected is None or not expected.strip():
                # 参考实现跑不通（依赖缺失）或无可见输出（断言式测试）→ 不适合判题
                challengeable = False
            return self._send(200, json.dumps({
                "challengeable": challengeable,
                "expected": expected,
                "skeleton": CHALLENGE_SKELETON,
                "note": note,
                "hints": hints,
            }))
        if self.path == "/api/cookbook/progress":
            progress = load_json(os.path.join(ROOT, "work", "cookbook_progress.json"), {})
            return self._send(200, json.dumps(progress))
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
        p = os.path.join(WORK, os.path.basename(f))
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
        if "?" in self.path:
            self.path = self.path.split("?", 1)[0]
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
            if f not in BY_FILE and f != SCRATCH_FILE and \
               not re.fullmatch(r"(?:cookbook|playground|zbe)_[A-Za-z0-9-]+\.zig", f):
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
                with _lock:
                    progress = load_json(PROGRESS, {})
                    progress[ex["file"]] = True
                    save_json(PROGRESS, progress)
            return self._send(200, json.dumps({**res, "submission": True,
                "attempts": sum(1 for s in subs if s["file"] == ex["file"])}))
        if self.path == "/api/lint":
            b = self._json_body()
            f = os.path.basename(b.get("file") or "")
            if f not in BY_FILE and f != SCRATCH_FILE and \
               not re.fullmatch(r"(?:cookbook|playground|zbe)_[A-Za-z0-9-]+\.zig", f):
                return self._send(400, json.dumps({"error": "unknown exercise"}))
            return self._send(200, json.dumps({"diagnostics": zig_lint(f, b.get("code") or "")}))
        if self.path == "/api/env/select":
            b = self._json_body()
            ok, info = apply_zig_version(b.get("version") or "")
            # 元数据变了，重新加载题库
            with _lock:
                EXERCISES = load_json(DATA, [])
                BY_FILE = {e["file"]: e for e in EXERCISES}
            return self._send(200, json.dumps({"ok": ok, "ziglings": info} if ok
                                              else {"error": info}))
        if self.path == "/api/zbe/done":
            b = self._json_body()
            slug = b.get("slug") or ""
            with _lock:
                progress = load_json(os.path.join(ROOT, "work", "zbe_progress.json"), {})
                if b.get("done"):
                    progress[slug] = True
                else:
                    progress.pop(slug, None)
                save_json(os.path.join(ROOT, "work", "zbe_progress.json"), progress)
            return self._send(200, json.dumps({"ok": True}))
        if self.path.startswith("/api/runbg/stop/"):
            rid = self.path.rsplit("/", 1)[1]
            ent = BGRUNS.get(rid)
            if ent and ent["p"] and ent["p"].poll() is None:
                ent["p"].kill()
            return self._send(200, json.dumps({"ok": True}))
        if self.path == "/api/cookbook/run":
            b = self._json_body()
            rid = b.get("id") or "unknown"
            fname = os.path.basename(b.get("file") or f"cookbook_{rid}.zig")
            if not re.fullmatch(r"[A-Za-z0-9_-]+\.zig", fname):
                return self._send(400, json.dumps({"error": "bad file"}))
            _cookbook_ensure_fixtures(b.get("code") or "")
            res = run_scratch(b.get("code") or "", filename=fname,
                              cwd=WORK, timeout=150,  # 首次编译新 std 模块较慢
                              args=b.get("args"))
            res["cookbook"] = True
            return self._send(200, json.dumps(res))
        if self.path == "/api/cookbook/judge":
            b = self._json_body()
            rid = b.get("id") or ""
            if not re.fullmatch(r"[a-z0-9-]+(?:__[a-z0-9-]+)*", rid):
                return self._send(400, json.dumps({"error": "bad id"}))
            lang = b.get("lang") if b.get("lang") in ("zh-CN", "en-US") else "zh-CN"
            try:
                r = cookbook.get_recipe(rid, lang)
            except Exception as e:
                return self._send(502, json.dumps({"error": f"拉取失败: {e}"}))
            ref_code = cookbook_code_for(rid, r["code"])
            expected = _cookbook_expected(rid, ref_code)
            if expected is None:
                return self._send(200, json.dumps({"passed": False,
                    "stderr": "该配方无法自动判题（参考实现运行失败）", "stdout": ""}))
            _cookbook_ensure_fixtures(b.get("code") or "")
            p = _cookbook_run_code(b.get("code") or "", timeout=90)
            seen = (p.stdout + p.stderr).strip()
            passed = p.returncode == 0 and normalize(seen) == normalize(expected)
            return self._send(200, json.dumps({
                "passed": passed, "returncode": p.returncode,
                "stdout": p.stdout, "stderr": p.stderr,
                "outputSeen": seen, "expected": expected, "judged": True,
                "hints": cookbook_hints(ref_code),
            }))
        if self.path == "/api/cookbook/done":
            b = self._json_body()
            rid = b.get("id") or ""
            if not re.fullmatch(r"[a-z0-9-]+(?:__[a-z0-9-]+)*", rid):
                return self._send(400, json.dumps({"error": "bad id"}))
            with _lock:
                progress = load_json(os.path.join(ROOT, "work", "cookbook_progress.json"), {})
                if b.get("done"):
                    progress[rid] = True
                else:
                    progress.pop(rid, None)
                save_json(os.path.join(ROOT, "work", "cookbook_progress.json"), progress)
            return self._send(200, json.dumps({"ok": True}))
        if self.path == "/api/runbg/start":
            b = self._json_body()
            fname = os.path.basename(b.get("file") or "scratch.zig")
            if not re.fullmatch(r"[A-Za-z0-9_-]+\.zig", fname):
                return self._send(400, json.dumps({"error": "bad file"}))
            args = b.get("args") or []
            for a in args:
                if not isinstance(a, str) or len(a) > 64 or not re.fullmatch(r"[A-Za-z0-9._:@-]*", a):
                    return self._send(400, json.dumps({"error": "非法参数"}))
            mode = b.get("mode") if b.get("mode") in ("run", "test") else "run"
            try:
                rid = start_bg_run(b.get("code") or "", fname, args, WORK, mode)
            except RuntimeError as e:
                return self._send(429, json.dumps({"error": str(e)}))
            return self._send(200, json.dumps({"runId": rid}))
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


SCRATCH_FILE = "scratch.zig"
SCRATCH_TEMPLATE = """const std = @import("std");

pub fn main() void {
    // 实验场：随便写，Ctrl+Enter 立即运行，代码自动保存
    std.debug.print("hello, scratch!\n", .{});
}
"""


def run_scratch(code, filename=SCRATCH_FILE, cwd=None, timeout=None, args=None):
    """自由实验：编译+运行，不判题，退出码 0 即通过。args 为程序命令行参数。"""
    timeout = timeout or RUN_TIMEOUT
    path = os.path.join(WORK, filename)
    extra = list(args or [])[:8]
    for a in extra:
        if not isinstance(a, str) or len(a) > 64 or not re.fullmatch(r"[A-Za-z0-9._:@-]*", a):
            return {"passed": False, "returncode": -1, "stdout": "", "stderr": "非法参数",
                    "outputSeen": "", "expected": "", "scratch": True}
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
        cmd = [zig_exe(), "run", path]
        if extra:
            cmd += ["--"] + extra
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env=ZIG_ENV,
                             cwd=cwd or ROOT)
        try:
            out, err = p.communicate(timeout=timeout)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            p.kill()
            out, err = p.communicate()  # 保留已产生的部分输出（如 "listening on ..."）
            return {"passed": False, "timeout": True, "returncode": -1,
                    "stdout": out, "stderr": err, "timeoutSecs": timeout,
                    "outputSeen": (out + err).strip(), "expected": "", "scratch": True}
    return {"passed": rc == 0, "returncode": rc,
            "stdout": out, "stderr": err,
            "outputSeen": (out + err).strip(),
            "expected": "", "scratch": True}


# ---------- cookbook 挑战模式（A 类确定性配方的模拟练习） ----------
# 06-01(rand) 输出非确定性，已排除；空输出（断言式测试）的配方自动降级
CHALLENGEABLE_CHAPTERS = {"01", "02", "09", "10", "11", "12", "13", "15"}
CHALLENGE_SKELETON = """const std = @import("std");

pub fn main() void {
    // TODO: 阅读 Cookbook 讲解后，从零实现这个任务，
    //       让程序输出与参考实现一致，然后提交挑战。
}
"""


def _cookbook_expected_path(rid):
    ver = (selected_zig_version() or "default").replace(".", "_")
    return os.path.join(ROOT, "work", "cache", "cookbook", f"expected_{ver}_{rid}.txt")


def _cookbook_run_code(code, timeout=None):
    """运行 cookbook 代码（cwd=work/runs，自动准备夹具），返回结果。"""
    timeout = timeout or 90
    path = os.path.join(WORK, "cookbook_tmp_run.zig")
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
        try:
            return subprocess.run([zig_exe(), "run", path], capture_output=True,
                                  text=True, timeout=RUN_TIMEOUT, env=ZIG_ENV, cwd=WORK)
        except subprocess.TimeoutExpired:
            class _T:
                returncode = -1
                stdout = ""
                stderr = f"Timed out after {RUN_TIMEOUT}s."
            return _T()


def _cookbook_ensure_fixtures(code):
    for m in re.finditer(r'"((?:tests|inputs|data|files)/[^"\n]+)"', code):
        rel = m.group(1)
        if ".." in rel or rel.startswith("/"):
            continue
        dst = os.path.join(WORK, rel)
        if not os.path.exists(dst):
            try:
                content, _ = cookbook.fetch_cached(rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(content)
            except Exception:
                pass


def _cookbook_expected(rid, ref_code):
    """参考实现的期望输出（文件缓存；没有则现场运行参考代码捕获）。"""
    ep = _cookbook_expected_path(rid)
    if os.path.isfile(ep):
        return open(ep, encoding="utf-8").read()
    _cookbook_ensure_fixtures(ref_code)
    p = _cookbook_run_code(ref_code)
    if p.returncode != 0:
        return None
    # cookbook 配方惯用 std.debug.print（stderr），合并两路作为输出
    expected = (p.stdout + p.stderr).strip()
    os.makedirs(os.path.dirname(ep), exist_ok=True)
    with open(ep, "w", encoding="utf-8") as fh:
        fh.write(expected)
    return expected



OVERRIDES = load_json(os.path.join(ROOT, "web", "data", "cookbook_overrides.json"), {})


def cookbook_code_for(rid, original):
    """挑战模式使用覆盖层代码（输出可判题的变体），否则用上游原版。"""
    ov = OVERRIDES.get(rid)
    if ov and ov.get("code"):
        return ov["code"]
    return original


def cookbook_hints(code):
    """从参考代码提取渐进提示：函数签名 + 用到的 std 符号。"""
    sigs = re.findall(r"(?:pub )?fn ([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)", code)
    sig_hints = [f"fn {name}({params.strip()[:60]}{'…' if len(params.strip()) > 60 else ''})"
                 for name, params in sigs if name != "main"][:4]
    syms = []
    for m in re.finditer(r"std\.[A-Za-z_][A-Za-z0-9_.]*", code):
        s2 = ".".join(m.group(0).split(".")[:3])
        if s2 not in syms:
            syms.append(s2)
        if len(syms) >= 6:
            break
    return {"signatures": sig_hints, "stdSymbols": syms}

# ---------- 后台运行任务（支持同时跑服务器+客户端） ----------
BGRUNS = {}   # runId -> {"p":Popen,"out":[],"lock":Lock,"done":bool,"rc":None,"file":str,"thread":...}
BG_LOCK = threading.Lock()
BG_HARD_LIMIT = 600  # 后台任务最长 10 分钟


def _bg_worker(run_id, code, filename, args, cwd, mode="run"):
    ent = BGRUNS[run_id]
    path = os.path.join(WORK, filename)
    with _lock:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(code)
    cmd = [zig_exe(), "test" if mode == "test" else "run", path]
    if args:
        cmd += ["--"] + args
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=ZIG_ENV, cwd=cwd)
    except Exception as e:
        ent["err"].append(str(e))
        ent["done"] = True
        ent["rc"] = -1
        return
    ent["p"] = p
    started = time.time()

    def pump(pipe, sink):
        for line in iter(pipe.readline, ""):
            with ent["lock"]:
                sink.append(line)
                # 限制缓冲 200KB
                if sum(len(x) for x in ent["out"]) > 200_000:
                    del ent["out"][0]
        pipe.close()

    t1 = threading.Thread(target=pump, args=(p.stdout, ent["out"]), daemon=True)
    t2 = threading.Thread(target=pump, args=(p.stderr, ent["out"]), daemon=True)
    t1.start(); t2.start()
    while p.poll() is None and time.time() - started < BG_HARD_LIMIT:
        time.sleep(0.2)
    if p.poll() is None:
        p.kill()
    ent["rc"] = p.wait()
    t1.join(timeout=2); t2.join(timeout=2)
    ent["done"] = True


_BG_SEQ = 0


def start_bg_run(code, filename, args=None, cwd=None, mode="run"):
    global _BG_SEQ
    _BG_SEQ += 1
    rid = f"r{int(time.time()*1000)}_{_BG_SEQ}"  # 唯一 rid：并发同毫秒不再互相覆盖
    args = [a for a in (args or [])][:8]
    ent = {"p": None, "out": [], "err": [], "done": False, "rc": None,
           "file": filename, "lock": threading.Lock()}
    with BG_LOCK:
        running = sum(1 for e in BGRUNS.values() if not e["done"])
        if running >= 6:
            raise RuntimeError("后台运行任务已达上限（6 个），请先停止部分任务")
        BGRUNS[rid] = ent
        if len(BGRUNS) > 12:
            for k in list(BGRUNS)[:-12]:
                if BGRUNS[k].get("done"):
                    BGRUNS.pop(k, None)
    t = threading.Thread(target=_bg_worker, args=(rid, code, filename, args, cwd or WORK, mode), daemon=True)
    ent["thread"] = t
    t.start()
    return rid


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
