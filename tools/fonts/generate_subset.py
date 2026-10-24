#!/usr/bin/env python3
"""Generate the Keundal UI WOFF2 subset from bundled locale sources."""

from __future__ import annotations

import ast
import re
import sys
import unicodedata
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "packages/chat-app/app/assets/fonts"
FONT_CSS = ROOT / "packages/chat-app/app/assets/css/ui-font.css"
SOURCE = ROOT / "packages/chat-app/node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2"
LOCALE_PACKAGES = (
    "ui",
    "ui-layout",
    "ui-chat-list",
    "ui-home",
    "ui-composer",
    "ui-model-selection",
)
PROPERTY_VALUE = re.compile(r":\s*((?:'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"))", re.DOTALL)


def locale_corpus() -> tuple[str, int]:
    values: set[str] = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~…·•—–“”‘’「」『』（）［］【】〈〉《》·×÷％※₩€£¥")
    count = 0
    for package in LOCALE_PACKAGES:
        for language in ("en", "ko"):
            path = ROOT / "packages" / package / "app/locales" / f"{language}.ts"
            source = path.read_text(encoding="utf-8")
            for match in PROPERTY_VALUE.finditer(source):
                try:
                    value = ast.literal_eval(match.group(1))
                except (SyntaxError, ValueError) as error:
                    raise ValueError(f"Unsupported locale string in {path}") from error
                if isinstance(value, str):
                    values.update(value)
                    count += 1
    return "".join(sorted(values)), count


def rename_family(font: TTFont) -> None:
    replacements = {
        1: "Keundal UI",
        2: "Variable",
        3: "KeundalUI-Variable;1.3.9;subset",
        4: "Keundal UI Variable",
        6: "KeundalUI-Variable",
        16: "Keundal UI",
        17: "Variable",
        25: "KeundalUI",
    }
    names = font["name"]
    for record in list(names.names):
        if record.nameID in replacements:
            names.setName(
                replacements[record.nameID], record.nameID,
                record.platformID, record.platEncID, record.langID,
            )
    names.setName((ASSETS / "LICENSE-Pretendard.txt").read_text(encoding="utf-8"), 13, 3, 1, 0x409)


def main() -> int:
    if not SOURCE.is_file():
        raise SystemExit(f"Missing source font: {SOURCE}")
    text, locale_count = locale_corpus()
    with TTFont(SOURCE) as source_font:
        cmap = set().union(*(set(table.cmap) for table in source_font["cmap"].tables))
        weight = next(axis for axis in source_font["fvar"].axes if axis.axisTag == "wght")
        weight_range = f"{weight.minValue:g}-{weight.maxValue:g}"
    covered = {ord(char) for char in text} & cmap
    missing = {ord(char) for char in text} - cmap
    if missing:
        raise SystemExit(f"Source font does not cover corpus codepoints: {len(missing)}")

    hangul = {char for char in text if unicodedata.name(char, "").startswith("HANGUL")}
    groups = {"latin": set(text) - hangul, "hangul": hangul}
    css = ["/* tools/fonts/generate_subset.py로 생성합니다. */\n"]
    ASSETS.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    for label, characters in groups.items():
        with TTFont(SOURCE) as font:
            subsetter = subset.Subsetter()
            subsetter.populate(text="".join(sorted(characters)))
            subsetter.subset(font)
            rename_family(font)
            font.recalcTimestamp = False
            font.flavor = "woff2"
            destination = ASSETS / f"keundal-ui-{label}.woff2"
            font.save(destination)
        ranges: list[list[int]] = []
        for codepoint in sorted(map(ord, characters)):
            if ranges and codepoint == ranges[-1][1] + 1:
                ranges[-1][1] = codepoint
            else:
                ranges.append([codepoint, codepoint])
        unicode_range = ", ".join(
            f"U+{start:X}" if start == end else f"U+{start:X}-{end:X}"
            for start, end in ranges
        )
        css.append(
            "@font-face {\n"
            "  font-family: 'Keundal UI';\n"
            "  font-style: normal;\n"
            "  font-display: swap;\n"
            "  font-weight: 45 920;\n"
            f"  src: url('../fonts/{destination.name}') format('woff2-variations');\n"
            f"  unicode-range: {unicode_range};\n"
            "}\n"
        )
        total_bytes += destination.stat().st_size
        print(f"{label}_codepoints={len(characters)}")
        print(f"{label}_bytes={destination.stat().st_size}")
    with FONT_CSS.open("w", encoding="utf-8", newline="\n") as output:
        output.write("\n".join(css))
    print(f"fontTools={__import__('fontTools').__version__}")
    print(f"weight_range={weight_range}")
    print(f"source={SOURCE.relative_to(ROOT).as_posix()}")
    print(f"locale_strings={locale_count}")
    print(f"corpus_codepoints={len(text)}")
    print(f"source_font_coverage={len(covered)}/{len(text)}")
    print(f"unsupported_codepoints={len(missing)}")
    print(f"font_bytes={total_bytes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
