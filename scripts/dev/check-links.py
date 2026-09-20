#!/usr/bin/env python3
"""Fail if a relative link in a Markdown file points at a path that does not exist.

Usage: check-links.py [repository-root]

Every tracked *.md file is read. Links inside fenced code blocks and inline code are
ignored. External links (a scheme such as https:, mailto:) and pure #anchors are not
checked; a link of the form path.md#anchor is checked for the path only. Anchors are
not verified, because heading slugs differ between renderers.

Exit status 1 and one line per broken link on failure, 0 otherwise.
"""

import os
import re
import subprocess
import sys
from urllib.parse import unquote

INLINE = re.compile(r"!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)[^)]*\)")
REFERENCE = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
INLINE_CODE = re.compile(r"`[^`]*`")


def markdown_files(root):
    try:
        out = subprocess.check_output(
            ["git", "-C", root, "ls-files", "-z", "*.md"], stderr=subprocess.DEVNULL
        )
        names = [n for n in out.decode("utf-8").split("\0") if n]
    except (OSError, subprocess.CalledProcessError):
        names = []
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
            for f in files:
                if f.endswith(".md"):
                    names.append(os.path.relpath(os.path.join(base, f), root))
    return sorted(names)


def links(text):
    in_fence = False
    fence = ""
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence, fence = True, marker
            elif marker == fence:
                in_fence = False
            continue
        if in_fence:
            continue
        line = INLINE_CODE.sub("", line)
        for match in INLINE.finditer(line):
            yield number, match.group(1)
        match = REFERENCE.match(line)
        if match:
            yield number, match.group(1)


def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
    broken = []
    checked = 0
    for name in markdown_files(root):
        path = os.path.join(root, name)
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        for number, target in links(text):
            target = target.strip("<>")
            if not target or target.startswith("#") or SCHEME.match(target):
                continue
            target = unquote(target.split("#", 1)[0].split("?", 1)[0])
            if not target:
                continue
            if target.startswith("/"):
                resolved = os.path.join(root, target.lstrip("/"))
            else:
                resolved = os.path.join(os.path.dirname(path), target)
            checked += 1
            if not os.path.exists(resolved):
                broken.append(f"{name}:{number}: {target}")
    for line in broken:
        print(line)
    print(f"{checked} relative links checked, {len(broken)} broken")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
