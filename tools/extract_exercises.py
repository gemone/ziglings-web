#!/usr/bin/env python3
"""Extract exercise metadata from ziglings/rivendell/elrond.zig into web/data/exercises.json."""
import json, re, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELROND = os.path.join(ROOT, "ziglings", "rivendell", "elrond.zig")
OUT = os.path.join(ROOT, "web", "data", "exercises.json")

src = open(ELROND, encoding="utf-8").read()

# Isolate the `const exercises = [_]Exercise{ ... };` block
m = re.search(r"const exercises = \[_\]Exercise\{(.*)\n\};", src, re.S)
body = m.group(1)

# Split into top-level `. { ... }` entries
entries, depth, cur, i = [], 0, None, 0
while i < len(body):
    c = body[i]
    if cur is None:
        if c == "." and body[i+1] == "{":
            cur = ".{"; depth = 1; i += 2; continue
    else:
        if c == "{" and "{s}" not in body[i:i+4]:
            pass
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                entries.append(cur); cur = None; i += 2; continue
        cur += c
    i += 1


def parse_str_field(entry, name):
    """Parse `.name = <value>,` where value is "..." or multiline \\ literals or ++ concat."""
    mm = re.search(r"\." + name + r"\s*=\s*", entry)
    if not mm:
        return None
    i = mm.end()
    parts = []
    while i < len(entry):
        # skip whitespace and separators
        while i < len(entry) and entry[i] in " \n\t,+":
            i += 1
        if i >= len(entry):
            break
        if entry[i] == '"':
            j = i + 1; buf = ""
            while entry[j] != '"':
                if entry[j] == "\\":
                    nxt = entry[j+1]
                    buf += {"n": "\n", "t": "\t", "\\": "\\", '"': '"'}.get(nxt, nxt)
                    j += 2
                else:
                    buf += entry[j]; j += 1
            parts.append(buf); i = j + 1
        elif entry.startswith("\\\\", i):
            j = i + 2
            while j < len(entry) and entry[j] != "\n":
                j += 1
            parts.append(entry[i+2:j] + "\n")
            i = j
        else:
            break
    val = "".join(parts)
    return val.rstrip("\n") if val else val


def parse_bool(entry, name):
    return bool(re.search(r"\." + name + r"\s*=\s*true", entry))

exercises = []
for e in entries:
    f = parse_str_field(e, "main_file")
    if not f:
        continue
    exercises.append({
        "file": f,
        "n": int(f.split("_")[0]),
        "title": re.sub(r"^\d+_", "", f[:-4]).replace("_", " ").title(),
        "output": parse_str_field(e, "output") or "",
        "hint": parse_str_field(e, "hint"),
        "skip_hint": parse_str_field(e, "skip_hint"),
        "check_stdout": parse_bool(e, "check_stdout"),
        "link_libc": parse_bool(e, "link_libc"),
        "timestamp": parse_bool(e, "timestamp"),
        "skip": parse_bool(e, "skip"),
    })

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(exercises, fh, ensure_ascii=False, indent=1)
print(f"wrote {len(exercises)} exercises -> {OUT}")
