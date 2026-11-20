"""Extract plain text from exam papers (pdf/docx/pptx) for question mining."""
import os
import re
import sys
import json
import pathlib

SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/exam-papers-src")
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/exam-text")
OUT.mkdir(parents=True, exist_ok=True)


def norm(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def read_pdf(path: pathlib.Path) -> str:
    import fitz

    parts = []
    with fitz.open(path) as doc:
        for page in doc:
            parts.append(page.get_text("text"))
    return "\n".join(parts)


def read_docx(path: pathlib.Path) -> str:
    import docx

    doc = docx.Document(str(path))
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            parts.append(" | ".join(cells))
    return "\n".join(parts)


def read_pptx(path: pathlib.Path) -> str:
    from pptx import Presentation

    parts = []
    prs = Presentation(str(path))
    for index, slide in enumerate(prs.slides, 1):
        parts.append(f"\n[slide {index}]")
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                parts.append(shape.text_frame.text)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    parts.append(" | ".join(c.text for c in row.cells))
    return "\n".join(parts)


def read_doc(path: pathlib.Path) -> str:
    raw = path.read_bytes()
    try:
        import olefile

        if olefile.isOleFile(str(path)):
            ole = olefile.OleFileIO(str(path))
            if ole.exists("WordDocument"):
                data = ole.openstream("WordDocument").read()
                raw = data
    except Exception:
        pass
    chunks = re.findall(rb"[\x20-\x7e\x80-\xff]{4,}", raw)
    text = []
    for chunk in chunks:
        try:
            decoded = chunk.decode("utf-16-le", errors="ignore")
        except Exception:
            decoded = ""
        if sum(ch.isprintable() for ch in decoded) < len(decoded) * 0.7:
            decoded = chunk.decode("gb18030", errors="ignore")
        text.append(decoded)
    return "\n".join(text)


READERS = {".pdf": read_pdf, ".docx": read_docx, ".pptx": read_pptx, ".doc": read_doc}
QUESTION_HINT = re.compile(r"(选择题|判断题|填空题|简答题|（\s*）|\(\s*\)|^\s*[ABCD][\.\、\s])", re.M)

report = []
for path in sorted(SRC.iterdir()):
    if not path.is_file():
        continue
    ext = path.suffix.lower()
    reader = READERS.get(ext)
    if not reader:
        continue
    try:
        text = norm(reader(path))
        error = None
    except Exception as exc:  # noqa: BLE001
        text, error = "", f"{type(exc).__name__}: {exc}"
    (OUT / f"{path.stem}.txt").write_text(text, encoding="utf-8")
    hits = len(QUESTION_HINT.findall(text))
    report.append(
        {
            "key": path.stem,
            "ext": ext,
            "chars": len(text),
            "questionHints": hits,
            "error": error,
        }
    )

json.dump(report, open(OUT / "_report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
ok = [r for r in report if r["chars"] > 200]
print(f"files={len(report)} usable={len(ok)} empty={len(report) - len(ok)}")
for r in sorted(report, key=lambda x: -x["chars"]):
    flag = "OK " if r["chars"] > 200 else "BAD"
    print(f"{flag} {r['ext']:5} chars={r['chars']:6} hints={r['questionHints']:4} {r['key'][:12]} {r['error'] or ''}")
