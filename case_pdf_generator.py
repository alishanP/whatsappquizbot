from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.pagesizes import LETTER
import os, json, re
from typing import Optional, Dict, Any, List

# Preferred display order for common clinical keys (others will follow alphabetically)
CLINICAL_PREFERRED_ORDER = [
    "presenting_va", "unaided_va", "near_va",
    "subjective_refraction", "near_add",
    "tonometry", "ioP", "pachymetry",
    "pupils", "cover_test",
    "slit_lamp_exam", "anterior_segment",
    "fundus", "fundus_exam",
    "gonioscopy", "optic_nerve", "visual_fields",
    "tear_breakup_time", "tbuts", "keratometry",
]

IMAGING_PREFERRED_ORDER = [
    "oct", "rnfl", "mac_oct", "macular_oct",
    "fundus_photo", "fundus_photography",
    "hvf", "vf", "gdx", "hRT"
]

def _styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Small", parent=styles["Normal"], fontSize=9, leading=12))
    styles.add(ParagraphStyle(name="BlockLabel", parent=styles["Normal"], fontName="Helvetica-Bold"))
    styles.add(ParagraphStyle(name="Heading1Center", parent=styles["Heading1"], alignment=1))
    return styles

def _p(label: str, text: str, styles):
    return Paragraph(f"<b>{label}:</b> {text}", styles["Normal"])

def _pretty_label(key: str) -> str:
    """
    Convert keys like 'fundus_exam' or 'tear_breakup_time' or 'ioP' to nice labels.
    """
    if not key:
        return ""
    # Normalize common oddities
    fixes = {
        "iop": "IOP",
        "ioP": "IOP",
        "rnfl": "RNFL",
        "cd_ratio": "C/D ratio",
        "tbut": "TBUT",
        "tbuts": "TBUTs",
        "va": "VA",
        "onh": "ONH",
        "oct": "OCT",
        "vf": "VF",
        "hvf": "HVF",
    }
    k_norm = key.strip()
    k_lower = k_norm.lower()

    if k_lower in fixes:
        return fixes[k_lower]

    # Replace underscores with spaces
    s = re.sub(r"[_\s]+", " ", k_norm)

    # Split camelCase / mixed case into words
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)

    s = s.lower().strip()

    # Specific replacements
    s = s.replace("tear breakup time", "Tear break-up time")
    s = s.replace("fundus exam", "Fundus exam")
    s = s.replace("optic nerve", "Optic nerve")

    # Title case then fix common acronyms
    nice = s.title()
    # Re-apply acronyms and common clinical terms
    replacements = {
        "Iop": "IOP",
        "Va": "VA",
        "Rnfl": "RNFL",
        "Cd Ratio": "C/D ratio",
        "Onh": "ONH",
        "Oct": "OCT",
        "Vf": "VF",
        "Hvf": "HVF",
        "Tbut": "TBUT",
    }
    for a, b in replacements.items():
        nice = nice.replace(a, b)
    return nice

def _ordered_items(data: Dict[str, Any], preferred_order: List[str]) -> List[tuple]:
    """
    Return (key, value) pairs with keys in preferred order first (if present),
    followed by remaining keys alphabetically.
    """
    if not isinstance(data, dict):
        return []

    # Normalize keys for matching: lowercase
    keys = list(data.keys())
    used = set()
    ordered = []

    # Map for case-insensitive matching
    lower_map = {k.lower(): k for k in keys}

    for pref in preferred_order:
        k = lower_map.get(pref.lower())
        if k and k not in used and data.get(k) not in (None, ""):
            ordered.append((k, data[k]))
            used.add(k)

    # Remaining keys not yet used, sorted by pretty label
    remaining = [(k, v) for k, v in data.items() if k not in used and v not in (None, "")]
    remaining.sort(key=lambda kv: _pretty_label(kv[0]))
    ordered.extend(remaining)
    return ordered

def case_to_pdf(case_data: dict, out_dir: str = ".", filename: Optional[str] = None) -> str:
    """
    Generate a single-case PDF (OEBC-style) WITHOUT questions.
    Works with flexible 'clinical_data' and 'imaging' fields.

    Expected structure (flexible):
      - case_id (str)
      - topic (str)
      - case_data: {
          demographics, chief_complaint, ocular_history, medical_history, family_history (opt),
          clinical_data: { ... any fields ... },
          imaging: { ... any fields ... }
        }
      - questions: [ ... ]   # Ignored for PDF generation
    """
    styles = _styles()

    # Resolve filename
    case_id = case_data.get("case_id", "case")
    if not filename:
        safe = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in case_id)
        filename = f"{safe}.pdf"

    out_path = os.path.join(out_dir, filename)
    doc = SimpleDocTemplate(out_path, pagesize=LETTER, title=case_id)

    meta_topic = case_data.get("topic", "")
    c: Dict[str, Any] = case_data.get("case_data", {}) or {}
    clinical: Dict[str, Any] = c.get("clinical_data", {}) or {}
    imaging: Dict[str, Any] = c.get("imaging", {}) or {}

    story = []
    story.append(Paragraph("Written Exam – Sample Case", styles["Heading1Center"]))
    if meta_topic:
        story.append(Paragraph(_pretty_label(meta_topic), styles["Small"]))
    story.append(Paragraph("Property of OEBC", styles["Small"]))
    story.append(Spacer(1, 12))

    # Case header
    story.append(Paragraph("CASE DATA", styles["Heading2"]))
    story.append(_p("Case ID", case_id, styles))
    if meta_topic:
        story.append(_p("Topic", meta_topic, styles))

    # Core history blocks
    story.append(_p("Demographics", c.get("demographics", "") , styles))
    story.append(_p("Chief Complaint", c.get("chief_complaint", "") , styles))
    story.append(_p("Ocular History", c.get("ocular_history", "") , styles))
    story.append(_p("Medical History", c.get("medical_history", "") , styles))
    if c.get("family_history"):
        story.append(_p("Family History", c.get("family_history", "") , styles))

    # Clinical data (generic & ordered)
    if isinstance(clinical, dict) and clinical:
        story.append(Spacer(1, 6))
        story.append(Paragraph("<b>Clinical Data:</b>", styles["BlockLabel"]))
        for k, v in _ordered_items(clinical, CLINICAL_PREFERRED_ORDER):
            story.append(Paragraph(f"{_pretty_label(k)}: {v}", styles["Normal"]))

    # Imaging
    if isinstance(imaging, dict) and imaging:
        story.append(Spacer(1, 6))
        story.append(Paragraph("<b>Imaging:</b>", styles["BlockLabel"]))
        for k, v in _ordered_items(imaging, IMAGING_PREFERRED_ORDER):
            story.append(Paragraph(f"{_pretty_label(k)}: {v}", styles["Normal"]))

    story.append(Spacer(1, 6))
    # The new format you sent doesn’t include "description"; omit rather than showing a blank.

    doc.build(story)
    return out_path

def batch_from_json(json_path: str, out_dir: str = ".") -> List[str]:
    """
    Read a JSON file containing either a single object or a list of objects.
    Generate PDFs for each case. Returns list of file paths.
    """
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cases = data if isinstance(data, list) else [data]
    os.makedirs(out_dir, exist_ok=True)
    outputs: List[str] = []
    for case in cases:
        case_id = case.get("case_id", "case")
        safe = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in case_id)
        fname = f"{safe}.pdf"
        outputs.append(case_to_pdf(case, out_dir=out_dir, filename=fname))
    return outputs

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Generate OEBC-style case PDFs from JSON (new flexible format)")
    ap.add_argument("json_path", help="Path to JSON file (single case or list of cases)")
    ap.add_argument("--out", default=".", help="Output directory")
    args = ap.parse_args()
    paths = batch_from_json(args.json_path, args.out)
    for p in paths:
        print(p)