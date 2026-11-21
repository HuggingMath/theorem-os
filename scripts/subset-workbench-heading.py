"""Regenerate the empty workbench heading font using FontTools and Brotli."""

from pathlib import Path
from tempfile import TemporaryDirectory

from fontTools.merge import Merger
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont


def main():
    fonts = Path(__file__).resolve().parents[1] / "docs" / "assets" / "fonts"
    sources = {
        "NotoSerifSC-ui.woff2": "想证明什么？",
        "NotoSerifSC-ui-extra.woff2": "今天",
    }
    with TemporaryDirectory(dir=fonts) as staging:
        parts = []
        for filename, text in sources.items():
            with TTFont(fonts / filename, recalcTimestamp=False) as font:
                subset = Subsetter(Options(layout_features=["*"]))
                subset.populate(text=text)
                subset.subset(font)
                font.flavor = None
                part = Path(staging) / Path(filename).with_suffix(".ttf")
                font.save(part)
                parts.append(part)
        heading = Merger().merge(parts)
        heading.recalcTimestamp = False
        heading.flavor = "woff2"
        names = heading["name"]
        for name_id, value in {
            1: "TheoremOS Workbench Heading",
            2: "Regular",
            3: "TheoremOS Workbench Heading",
            4: "TheoremOS Workbench Heading",
            6: "TheoremOSWorkbenchHeading",
        }.items():
            names.removeNames(nameID=name_id)
            names.setName(value, name_id, 3, 1, 0x409)
        heading.save(fonts / "TheoremOSWorkbenchHeading.woff2")


if __name__ == "__main__":
    main()
