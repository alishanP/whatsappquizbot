
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.enums import TA_LEFT
import os, json

def _styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Small", parent=styles["Normal"], fontSize=9, leading=12))
    styles.add(ParagraphStyle(name="BlockLabel", parent=styles["Normal"], fontName="Helvetica-Bold"))
    styles.add(ParagraphStyle(name="Heading1Center", parent=styles["Heading1"], alignment=1))
    return styles

def _p(label, text, styles):
    return Paragraph(f"<b>{label}:</b> {text}", styles["Normal"])

def case_to_pdf(case_data: dict, out_dir: str = ".", filename: str | None = None) -> str:
    """
    Generate a single-case PDF (OEBC-style) WITHOUT questions.
    case_data keys:
      - case_id (str)
      - topic (str)
      - case_data: {
          demographics, chief_complaint, ocular_history, medical_history,
          clinical_data: {
            presenting_va, subjective_refraction, cover_test, anterior_segment, fundus
          },
          description
        }
    Returns the output file path.
    """
    styles = _styles()

    # Resolve filename
    case_id = case_data.get("case_id", "case")
    if not filename:
        safe = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in case_id)
        filename = f"{safe}.pdf"

    out_path = os.path.join(out_dir, filename)
    doc = SimpleDocTemplate(out_path, pagesize=LETTER, title=case_id)

    c = case_data.get("case_data", {})
    clinical = c.get("clinical_data", {})

    story = []
    story.append(Paragraph(f"Written Exam – Sample Case", styles["Heading1Center"]))
    story.append(Paragraph("Property of OEBC", styles["Small"]))
    story.append(Spacer(1, 12))
    story.append(Paragraph("CASE DATA", styles["Heading2"]))

    story.append(_p("Demographics", c.get("demographics", "" ), styles))
    story.append(_p("Chief Complaint", c.get("chief_complaint", "" ), styles))
    story.append(_p("Ocular History", c.get("ocular_history", "" ), styles))
    story.append(_p("Medical History", c.get("medical_history", "" ), styles))

    story.append(Spacer(1, 6))
    story.append(Paragraph("<b>Clinical Data:</b>", styles["BlockLabel"]))
    if clinical:
        if clinical.get("presenting_va"):
            story.append(Paragraph(f"Presenting VA: {clinical['presenting_va']}", styles["Normal"]))
        if clinical.get("subjective_refraction"):
            story.append(Paragraph(f"Subjective Refraction: {clinical['subjective_refraction']}", styles["Normal"]))
        if clinical.get("cover_test"):
            story.append(Paragraph(f"Cover test: {clinical['cover_test']}", styles["Normal"]))
        if clinical.get("anterior_segment"):
            story.append(Paragraph(f"Anterior segment: {clinical['anterior_segment']}", styles["Normal"]))
        if clinical.get("fundus"):
            story.append(Paragraph(f"Fundus: {clinical['fundus']}", styles["Normal"]))

    story.append(Spacer(1, 6))
    story.append(_p("Description of relevant finding", c.get("description", "" ), styles))

    doc.build(story)
    return out_path

def batch_from_json(json_path: str, out_dir: str = ".") -> list[str]:
    """
    Read a JSON file containing either a single object or a list of objects.
    Generate PDFs for each case. Returns list of file paths.
    """
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cases = data if isinstance(data, list) else [data]
    os.makedirs(out_dir, exist_ok=True)
    outputs = []
    for case in cases:
        fname = f"{case.get('case_id','case')}.pdf"
        outputs.append(case_to_pdf(case, out_dir=out_dir, filename=fname))
    return outputs

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Generate OEBC-style case PDFs from JSON")
    ap.add_argument("json_path", help="Path to JSON file (single case or list of cases)")
    ap.add_argument("--out", default=".", help="Output directory")
    args = ap.parse_args()
    paths = batch_from_json(args.json_path, args.out)
    for p in paths:
        print(p)
