"""On-demand zigbyexample content layer (https://zigbyexample.neocities.org/).

Fetches pages at runtime, caches on disk with TTL, parses each page into
{slug, title, prose, snippets:[{zig, terminal}]}. Nothing is vendored.
"""
import html
import os
import re
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "work", "cache", "zbe")
BASE = "https://zigbyexample.neocities.org/"
TTL = float(os.environ.get("ZBE_TTL", "86400"))


def _cp(key):
    return os.path.join(CACHE, key.replace("/", "__"))


def fetch_cached(url, ttl=TTL):
    os.makedirs(CACHE, exist_ok=True)
    key = url.replace(BASE, "").replace("/", "__").replace("?", "_") or "index"
    cp = _cp(key)
    if os.path.isfile(cp) and time.time() - os.path.getmtime(cp) < ttl:
        return open(cp, encoding="utf-8").read(), True
    req = urllib.request.Request(url, headers={"User-Agent": "ziglings-web"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode("utf-8")
            with open(cp, "w", encoding="utf-8") as fh:
                fh.write(text)
            return text, False
        except Exception as e:
            last = e
            time.sleep(0.8 * (attempt + 1))
    if os.path.isfile(cp):
        return open(cp, encoding="utf-8").read(), True
    raise RuntimeError(f"fetch {url} failed: {last}")


def _strip_tags(fragment):
    """去标签 + 反转义（保留原始空白，不插入空格）。"""
    return html.unescape(re.sub(r"<[^>]+>", "", fragment))


def _parse_page(slug, raw):
    title_m = re.search(r"<h1[^>]*>(.*?)</h1>", raw, re.S)
    title = html.unescape(re.sub(r"<[^>]+>", "", title_m.group(1))).strip() if title_m else slug

    # 正文段落：h1 之后、第一个 <pre> 之前的 <p>
    body_start = raw.find("</h1>")
    body_end = raw.find("<pre", body_start)
    prose_html = raw[body_start:body_end if body_end != -1 else len(raw)]
    paras = []
    for p_html in re.findall(r"<p[^>]*>(.*?)</p>", prose_html, re.S):
        # 行内代码转 markdown 反引号
        p_html = re.sub(r"<code[^>]*>(.*?)</code>", r"`\1`", p_html)
        text = html.unescape(re.sub(r"<[^>]+>", "", p_html)).strip()
        if text:
            paras.append(text)
    prose = "\n\n".join(paras)

    # 按顺序配对：sourceCode zig 块 + 紧随其后的终端块
    snippets = []
    pres = [(m.start(), m.group(1), m.group(2)) for m in
            re.finditer(r'(<pre[^>]*>)(.*?)(?=</pre>)', raw, re.S)]
    i = 0
    while i < len(pres):
        pos, open_tag, content = pres[i]
        is_zig = "sourceCode zig" in open_tag
        plain = html.unescape(re.sub(r"<[^>]+>", "", content))
        if is_zig:
            zig = plain
            terminal = ""
            # 后一个块若是终端会话则配对
            if i + 1 < len(pres):
                _, open2, content2 = pres[i + 1]
                if "sourceCode" not in open2:
                    t2 = html.unescape(re.sub(r"<[^>]+>", "", content2))
                    if t2.strip().startswith("$"):
                        terminal = t2.strip()
                        i += 1
            snippets.append({"zig": zig.strip(), "terminal": terminal})
        i += 1
    return {"slug": slug, "title": title, "prose": prose, "snippets": snippets}


def list_pages():
    """首页解析全部示例 slug + 标题（缓存 24h）。"""
    cp = _cp("__list__")
    if os.path.isfile(cp) and time.time() - os.path.getmtime(cp) < TTL:
        return json_load(cp)
    raw, _ = fetch_cached(BASE, ttl=TTL)  # 索引同样走 TTL 缓存，避免每次切换都依赖网络
    links = re.findall(r'href="([a-z0-9-]+)(?:\.html)?"[^>]*>([^<]+)<', raw)
    out = []
    seen = set()
    for slug, text in links:
        if slug in ("index", "about", "style") or slug in seen:
            continue
        seen.add(slug)
        out.append({"slug": slug, "title": html.unescape(text).strip()})
    out.sort(key=lambda x: x["slug"])
    os.makedirs(CACHE, exist_ok=True)
    json_dump(cp, out)
    return out


def get_page(slug):
    if not re.fullmatch(r"[a-z0-9-]+", slug):
        raise ValueError("bad slug")
    raw, _ = fetch_cached(BASE + slug)
    page = _parse_page(slug, raw)
    page["url"] = BASE + slug
    return page


def json_load(path):
    import json
    return json.load(open(path, encoding="utf-8"))


def json_dump(path, obj):
    import json
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
