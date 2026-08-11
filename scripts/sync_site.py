"""Emit personal_website-ready copies of the Chess Lab.

    python scripts/sync_site.py                 # dry run: say what would change
    python scripts/sync_site.py --check         # same, but exit 1 if out of date
    python scripts/sync_site.py --write         # actually write into the site repo

The engine modules are copied byte for byte into ``assets/chess/``. Keeping them
in their own directory is the whole trick: their relative imports (``./rules.js``)
stay valid, so no source file is rewritten on the way to the site and there is
never a second, drifting copy of the rules. Only ``index.html`` is transformed,
by an explicit list of substitutions, and every one of them must match exactly
once or this script refuses to run.

It never touches git, never commits, and never deploys. The blocks it prints at
the end are for a human to paste after reviewing the diff.
"""

from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
WEB = PROJECT / "web"
SITE = Path("D:/Stanford/research/own/personal_website")

VERSION = "20260811a"
STYLESHEETS = ["chess.css", "chess-stage.css", "chess-panel.css", "chess-board.css"]

# (needle, replacement). Each must appear exactly once in web/index.html.
REWRITES = [
    ('href="base.css"', f'href="base.css?v={VERSION}"'),
    *[(f'href="{name}"', f'href="{name}?v={VERSION}"') for name in STYLESHEETS],
    (
        '<script type="module" src="./lib/app.js"></script>',
        f'<script type="module" src="/assets/chess/app.js?rev={VERSION}"></script>',
    ),
]

HEADERS_BLOCK = """/chess*
  Content-Security-Policy: default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self'; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'none'; upgrade-insecure-requests

/chess.css
  Cache-Control: public, max-age=604800, immutable
/chess-stage.css
  Cache-Control: public, max-age=604800, immutable
/chess-panel.css
  Cache-Control: public, max-age=604800, immutable
/chess-board.css
  Cache-Control: public, max-age=604800, immutable"""

SITEMAP_ENTRY = """  <url>
    <loc>https://cpwei.qzz.io/chess</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>"""

FUN_CARD = """Replace the CHESS/64 <article class="fun-card"> in fun.html with a link card:

  <a class="fun-card is-live" href="/chess">
    <div class="fun-visual chess-visual" aria-hidden="true"><span>&#9820;</span><span>&#9822;</span><span>&#9821;</span><span>&#9819;</span></div>
    <div class="fun-copy">
      <div class="fun-card-top"><span class="fun-index">03</span><span class="fun-status live">Playable now</span></div>
      <p class="fun-code">CHESS/64</p>
      <h3>Chess Lab</h3>
      <p>A clean board, an adjustable opponent, and an analysis view that names the computation behind every line.</p>
      <span class="fun-action">Open the board <b aria-hidden="true">&rarr;</b></span>
    </div>
  </a>

and change the hero sentence, which currently says two games are ready."""


def render_page() -> str:
    text = (WEB / "index.html").read_text(encoding="utf-8")
    for needle, replacement in REWRITES:
        found = text.count(needle)
        if found != 1:
            raise SystemExit(
                f"sync_site: expected exactly one {needle!r} in web/index.html, found {found}. "
                "The page changed shape; update REWRITES deliberately."
            )
        text = text.replace(needle, replacement)
    return text


def planned() -> list[tuple[Path, Path | None, str]]:
    """(destination, source, kind) for every file this script owns."""
    jobs: list[tuple[Path, Path | None, str]] = []
    for module in sorted((WEB / "lib").glob("*.js")):
        jobs.append((SITE / "assets" / "chess" / module.name, module, "copy"))
    for name in STYLESHEETS:
        jobs.append((SITE / name, WEB / name, "copy"))
    jobs.append((SITE / "chess.html", None, "render"))
    return jobs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write the files into the site repo")
    parser.add_argument("--check", action="store_true", help="exit 1 if the site copy is out of date")
    options = parser.parse_args()

    if not SITE.is_dir():
        print(f"sync_site: the site repo is not at {SITE}", file=sys.stderr)
        return 2

    page = render_page()
    stale: list[str] = []
    for destination, source, kind in planned():
        if kind == "render":
            current = destination.read_text(encoding="utf-8") if destination.exists() else None
            same = current == page
        else:
            same = destination.exists() and filecmp.cmp(source, destination, shallow=False)
        label = destination.relative_to(SITE)
        if same:
            print(f"  ok       {label}")
            continue
        stale.append(str(label))
        print(f"  {'write' if options.write else 'stale'}    {label}")
        if options.write:
            destination.parent.mkdir(parents=True, exist_ok=True)
            if kind == "render":
                destination.write_text(page, encoding="utf-8", newline="\n")
            else:
                shutil.copyfile(source, destination)

    # base.css is vendored the other way round: the site owns it.
    vendored = (WEB / "base.css").read_bytes()
    if vendored != (SITE / "base.css").read_bytes():
        print("\n  WARNING  web/base.css differs from the site's base.css.")
        print("           Re-copy the site copy into web/; never edit the vendored one.")

    if not stale:
        print("\nThe site copy is already up to date.")
        return 0
    if options.write:
        print(f"\nWrote {len(stale)} file(s) into {SITE}. Nothing was committed or deployed.")
    else:
        print(f"\n{len(stale)} file(s) would change. Re-run with --write to apply.")

    print("\n--- add to personal_website/_headers (script-src 'self' for this route only) ---")
    print(HEADERS_BLOCK)
    print("\n--- add to personal_website/sitemap.xml ---")
    print(SITEMAP_ENTRY)
    print("\n--- " + FUN_CARD)
    return 1 if (options.check and stale) else 0


if __name__ == "__main__":
    raise SystemExit(main())
