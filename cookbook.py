"""On-demand zig-cookbook content layer.

Fetches https://github.com/zigcc/zig-cookbook content at runtime
(raw.githubusercontent + GitHub tree API), caches it in work/cache/cookbook/
with a TTL, and parses .smd recipes into structured dicts. Nothing is vendored
into the repository — delete the cache dir to force a refresh.
"""
import json
import os
import re
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))  # workspace root
CACHE = os.path.join(ROOT, "work", "cache", "cookbook")
REPO = "zigcc/zig-cookbook"
BRANCH = "main"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"
TREE_API = f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1"
TTL = float(os.environ.get("COOKBOOK_TTL", "86400"))  # 24h

CHAPTER_DIRS = {
    "file-system": ("文件系统", "File system"),
    "cryptography": ("加密与哈希", "Crypto & hashes"),
    "date-time": ("日期与时间", "Date & time"),
    "networking-web": ("网络与 Web", "Networking & web"),
    "random": ("随机数", "Random"),
    "concurrency": ("并发", "Concurrency"),
    "systems-tools": ("系统与工具", "Systems & tools"),
    "encoding-text-processing": ("编码与文本处理", "Encoding & text processing"),
    "io": ("输入与输出", "I/O"),
    "algorithms-data-structures": ("算法与数据结构", "Algorithms & data structures"),
    "database": ("数据库", "Databases"),
    "general": ("综合", "General"),
}


def _cache_path(key):
    safe = key.replace("/", "__")
    return os.path.join(CACHE, safe)


def fetch_cached(relpath, ttl=TTL):
    """Fetch a repo file via raw.githubusercontent with on-disk TTL cache."""
    os.makedirs(CACHE, exist_ok=True)
    cp = _cache_path(relpath)
    if os.path.isfile(cp) and time.time() - os.path.getmtime(cp) < ttl:
        return open(cp, encoding="utf-8").read(), True
    req = urllib.request.Request(RAW + relpath, headers={"User-Agent": "ziglings-web"})
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            os.makedirs(os.path.dirname(cp), exist_ok=True)
            with open(cp, "wb") as fh:
                fh.write(raw)
            text = raw.decode("utf-8", "replace")
            return text, False
        except Exception as e:
            last_err = e
            time.sleep(0.5 * (attempt + 1))
    # 过期缓存兜底：网络失败时宁可给旧的
    if os.path.isfile(cp):
        return open(cp, encoding="utf-8").read(), True
    raise RuntimeError(f"fetch {relpath} failed: {last_err}")


def _recipe_ids():
    """Recipe ids (e.g. 01-01-read-file-line-by-line) from the GitHub tree API."""
    cp = _cache_path("__tree__")
    if os.path.isfile(cp) and time.time() - os.path.getmtime(cp) < TTL:
        tree = json.load(open(cp, encoding="utf-8"))
    else:
        req = urllib.request.Request(TREE_API, headers={"User-Agent": "ziglings-web"})
        last_err = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    tree = json.load(r)
                break
            except Exception as e:
                last_err = e
                time.sleep(0.5 * (attempt + 1))
        else:
            if os.path.isfile(cp):
                tree = json.load(open(cp, encoding="utf-8"))
            else:
                raise RuntimeError(f"tree fetch failed: {last_err}")
        os.makedirs(CACHE, exist_ok=True)
        json.dump(tree, open(cp, "w", encoding="utf-8"))
    ids = set()
    for item in tree.get("tree", []):
        m = re.match(r"src/zh-CN/(.+)\.smd$", item.get("path", ""))
        if m:
            base = m.group(1)
            if base.split("/")[-1] in ("index", "toc"):
                continue
            ids.add(base.replace("/", "__"))
    return sorted(ids)


_FM_TITLE = re.compile(r'^\.title\s*=\s*"(.*)"\s*,?\s*$', re.M)
_CODE_REF = re.compile(r"siteAsset\('([^']+)'\)")


def parse_recipe(rid, lang="zh-CN"):
    """Parse one recipe: {id, chapter, title, prose, code}."""
    relpath = rid.replace("__", "/")  # id 的 __ 分隔符还原为目录斜杠
    smd, _ = fetch_cached(f"src/{lang}/{relpath}.smd")
    title_m = _FM_TITLE.search(smd)
    title = title_m.group(1) if title_m else rid
    # 去掉 front-matter（第二行 --- 之后为正文）
    parts = smd.split("\n---\n", 1)
    body = parts[1] if len(parts) == 2 else smd
    prose = body.strip()
    code = ""
    code_m = _CODE_REF.search(body)
    if code_m:
        asset = code_m.group(1)  # siteAsset('src/01-01.zig') 实际位于 assets/src/
        if not asset.startswith("assets/"):
            asset = "assets/" + asset
        code, _ = fetch_cached(asset)
    chapter = rid.split("__", 1)[0]
    names = CHAPTER_DIRS.get(chapter, (chapter, chapter))
    return {
        "id": rid,
        "chapter": chapter,
        "chapterName": names[1] if lang == "en-US" else names[0],
        "title": title,
        "prose": prose,
        "code": code,
    }


def list_recipes(lang="zh-CN"):
    """All recipes (cached fast-path: one parsed JSON snapshot per lang+TTL)."""
    snapshot = _cache_path(f"__list_{lang}__")
    if os.path.isfile(snapshot) and time.time() - os.path.getmtime(snapshot) < TTL:
        cached = json.load(open(snapshot, encoding="utf-8"))
        if isinstance(cached, list) and cached:
            # id 集合与当前不一致 = 上游结构变更或旧格式残留 → 忽略重拉
            current_ids = {x["id"] for x in _recipe_ids()}
            if all(isinstance(r, dict) and r.get("id") in current_ids for r in cached):
                return cached
        if os.path.exists(snapshot):
            os.remove(snapshot)  # 空/损坏/过期格式的快照，重建
        os.remove(snapshot)
    out = []
    for rid in _recipe_ids():
        try:
            r = parse_recipe(rid, lang)
        except Exception:
            continue
        out.append({
            "id": r["id"], "chapter": r["chapter"],
            "chapterName": r["chapterName"], "title": r["title"],
        })
    out.sort(key=lambda r: (r["chapter"], r["id"]))
    # 只有全部配方解析成功才写快照；部分成功不缓存（下次请求继续补拉缺失的）
    if len(out) == len(_recipe_ids()):
        os.makedirs(CACHE, exist_ok=True)
        json.dump(out, open(snapshot, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return out


def get_recipe(rid, lang="zh-CN"):
    if not re.fullmatch(r"[a-z0-9-]+(?:__[a-z0-9-]+)*", rid):
        raise ValueError("bad recipe id")
    return parse_recipe(rid, lang)
