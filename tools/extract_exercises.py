#!/usr/bin/env python3
"""Extract exercise metadata from ziglings, supporting both metadata formats:

- new (main / 0.17-dev): rivendell/elrond.zig   — `exercises` table
- old (<= v0.16.x tags): build.zig              — `exercises = [_]Exercise{...}` table

Output: web/data/exercises.json
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIGLINGS = os.path.join(ROOT, "ziglings")
OUT = os.path.join(ROOT, "web", "data", "exercises.json")


def read(p):
    return open(p, encoding="utf-8").read()


def split_entries(body):
    """Split a zig declaration block into top-level `.{ ... },` entries."""
    entries = []
    depth = 0
    cur = None
    i = 0
    in_str = False
    while i < len(body):
        c = body[i]
        if in_str:
            cur += c
            if c == "\\":
                i += 1
                if i < len(body):
                    cur += body[i]
                    i += 1
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            cur += c
            i += 1
            continue
        if cur is None:
            if c == "." and body[i + 1:i + 2] == "{":
                cur = ".{"
                depth = 1
                i += 2
                continue
        else:
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    entries.append(cur)
                    cur = None
                    i += 2
                    continue
            cur += c
        i += 1
    return entries


def parse_string_field(entry, name):
    """Parse `.name = <"..." | \\\\multiline | concat>`, returns str or None."""
    m = re.search(r"\." + name + r"\s*=\s*", entry)
    if not m:
        return None
    i = m.end()
    parts = []
    while i < len(entry):
        while i < len(entry) and entry[i] in " \n\t,+":
            i += 1
        if i >= len(entry):
            break
        if entry.startswith('"', i):
            j = i + 1
            buf = ""
            while j < len(entry) and entry[j] != '"':
                if entry[j] == "\\" and j + 1 < len(entry):
                    nxt = entry[j + 1]
                    buf += {"n": "\n", "t": "\t", "\\": "\\", '"': '"'}.get(nxt, nxt)
                    j += 2
                else:
                    buf += entry[j]
                    j += 1
            parts.append(buf)
            i = j + 1  # skip closing quote
        elif entry.startswith("\\\\", i):
            j = entry.find("\n", i)
            j = j if j != -1 else len(entry)
            parts.append(entry[i + 2:j] + "\n")
            i = j + 1  # skip closing quote
        else:
            break
    val = "".join(parts)
    return val.rstrip("\n") if val else val


def parse_bool_flag(entry, name):
    return bool(re.search(r"\." + name + r"\s*=\s*true", entry))


def parse_table_generic(body):
    """解析 elrond.zig / build.zig 两种风格的练习表，输出统一 dict 列表。"""
    out = []
    for entry in split_entries(body):
        f = None
        for key in ("main_file", "path"):
            f = parse_string_field(entry, key)
            if f:
                break
        if not f or not f.endswith(".zig"):
            continue
        out.append({
            "file": os.path.basename(f),
            "output": parse_string_field(entry, "output") or "",
            "hint": parse_string_field(entry, "hint"),
            "check_stdout": parse_bool_flag(entry, "check_stdout"),
            "link_libc": parse_bool_flag(entry, "link_libc"),
            "timestamp": parse_bool_flag(entry, "timestamp"),
            "skip": parse_bool_flag(entry, "skip"),
        })
    out.sort(key=lambda x: x["file"])
    for n, e in enumerate(out, 1):
        e["n"] = n
        e["title"] = re.sub(r"^\d+[-_]", "", e["file"][:-4]).replace("_", " ").title()
    return out


def extract_from_elrond():
    src = read(os.path.join(ZIGLINGS, "rivendell", "elrond.zig"))
    m = re.search(r"const exercises = \[_\]Exercise\{(.*)\n\};", src, re.S)
    if not m:
        return None
    return parse_table_generic(m.group(1))


def extract_from_build():
    src = read(os.path.join(ZIGLINGS, "build.zig"))
    m = re.search(r"const exercises = \[_\]Exercise\{(.*)\n\};", src, re.S)
    if not m:
        return None
    return parse_table_generic(m.group(1))


def main():
    exercises = None
    source = None
    if os.path.exists(os.path.join(ZIGLINGS, "rivendell", "elrond.zig")):
        exercises = extract_from_elrond()
        source = "rivendell/elrond.zig (new format)"
    if not exercises:
        exercises = extract_from_build()
        source = "build.zig (old format)"
    if not exercises:
        print("ERROR: no exercise metadata found", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(exercises, fh, ensure_ascii=False, indent=1)
    print(f"wrote {len(exercises)} exercises (from {source}) -> {OUT}")


if __name__ == "__main__":
    main()
