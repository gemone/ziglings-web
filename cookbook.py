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

CHAPTERS = {
    "01": ("文件与目录", "Files & directories"),
    "02": ("加密与哈希", "Crypto & hashes"),
    "03": ("时间", "Time"),
    "04": ("TCP 网络", "TCP networking"),
    "05": ("HTTP", "HTTP"),
    "06": ("随机数", "Random"),
    "07": ("线程", "Threads"),
    "08": ("操作系统", "OS"),
    "09": ("语义化版本", "Semantic version"),
    "10": ("序列化", "Serialization"),
    "11": ("复数", "Complex numbers"),
    "12": ("数据结构", "Data structures"),
    "13": ("命令行参数", "CLI arguments"),
    "14": ("数据库", "Databases"),
    "15": ("正则与字符串", "Regex & strings"),
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
                text = r.read().decode("utf-8")
            with open(cp, "w", encoding="utf-8") as fh:
                fh.write(text)
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
        m = re.match(r"src/zh-CN/(\d\d-\d\d-[^/]+)\.smd$", item.get("path", ""))
        if m:
            ids.add(m.group(1))
    return sorted(ids)


_FM_TITLE = re.compile(r'^\.title\s*=\s*"(.*)"\s*,?\s*$', re.M)
_CODE_REF = re.compile(r"siteAsset\('([^']+)'\)")


def parse_recipe(rid, lang="zh-CN"):
    """Parse one recipe: {id, chapter, title, prose, code}."""
    smd, _ = fetch_cached(f"src/{lang}/{rid}.smd")
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
        if cached:  # 空快照是历史解析失败的产物，忽略重拉
            return cached
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
    os.makedirs(CACHE, exist_ok=True)
    json.dump(out, open(snapshot, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    return out


def get_recipe(rid, lang="zh-CN"):
    if not re.fullmatch(r"\d\d-\d\d-[a-z0-9-]+", rid):
        raise ValueError("bad recipe id")
    return parse_recipe(rid, lang)
