#!/usr/bin/env python3
"""Validate the static GitHub Pages project page in site/.

Checks, using only the standard library:
  1. Every local href/src inside site/**.html resolves to a real file
     (relative to the HTML file, matching how a browser resolves it).
  2. Each HTML file is well-formed: tags balance, and every void element
     is one of the known self-closing HTML void elements.

External (http/https), mailto:, tel:, and in-page (#anchor) references are
skipped — those are not local files for this workflow to check.
"""

from __future__ import annotations

import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

SITE_DIR = Path(__file__).resolve().parent.parent / "site"

VOID_ELEMENTS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}

LOCAL_REF_ATTRS = {"href", "src"}


def is_local_reference(value: str) -> bool:
    if not value:
        return False
    if value.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
        return False
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return False
    return True


class SiteHTMLChecker(HTMLParser):
    def __init__(self, html_path: Path):
        super().__init__(convert_charrefs=True)
        self.html_path = html_path
        self.errors: list[str] = []
        self.open_stack: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        for attr_name in LOCAL_REF_ATTRS:
            value = attrs_dict.get(attr_name)
            if value and is_local_reference(value):
                target_path = urlsplit(value).path
                resolved = (self.html_path.parent / target_path).resolve()
                if not resolved.exists():
                    self.errors.append(
                        f"{self.html_path.name}: <{tag} {attr_name}=\"{value}\"> "
                        f"does not resolve to an existing file ({resolved})"
                    )
        if tag not in VOID_ELEMENTS:
            self.open_stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        # Self-closed tag, e.g. <br/>. Treat like a start tag without push.
        self.handle_starttag(tag, attrs)
        if tag not in VOID_ELEMENTS and self.open_stack and self.open_stack[-1] == tag:
            self.open_stack.pop()

    def handle_endtag(self, tag):
        if tag in VOID_ELEMENTS:
            self.errors.append(
                f"{self.html_path.name}: void element <{tag}> has a closing tag"
            )
            return
        if not self.open_stack or self.open_stack[-1] != tag:
            self.errors.append(
                f"{self.html_path.name}: unexpected closing tag </{tag}> "
                f"(open stack: {self.open_stack})"
            )
            return
        self.open_stack.pop()

    def finish(self) -> list[str]:
        if self.open_stack:
            self.errors.append(
                f"{self.html_path.name}: unclosed tag(s) at end of document: "
                f"{self.open_stack}"
            )
        return self.errors


def check_html_file(html_path: Path) -> list[str]:
    checker = SiteHTMLChecker(html_path)
    checker.feed(html_path.read_text(encoding="utf-8"))
    checker.close()
    return checker.finish()


def main() -> int:
    if not SITE_DIR.is_dir():
        print(f"site directory not found: {SITE_DIR}", file=sys.stderr)
        return 1

    html_files = sorted(SITE_DIR.rglob("*.html"))
    if not html_files:
        print(f"no .html files found under {SITE_DIR}", file=sys.stderr)
        return 1

    all_errors: list[str] = []
    for html_path in html_files:
        all_errors.extend(check_html_file(html_path))

    if all_errors:
        print("site validation failed:", file=sys.stderr)
        for error in all_errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"OK: {len(html_files)} HTML file(s) under {SITE_DIR} are well-formed "
          "and every local href/src resolves.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
