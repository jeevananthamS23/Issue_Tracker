import csv
import json
import os
import re
from pathlib import Path
import pytest

@pytest.fixture(scope="module")
def semantic_pilot_data():
    f6_b11_dir = Path("data/manifest_out/f6_b11")
    csv_path = f6_b11_dir / "semantic_screening_results.csv"
    meta_path = f6_b11_dir / "semantic_screening_metadata.json"
    gallery_path = f6_b11_dir / "semantic_review_gallery.html"

    assert csv_path.exists(), f"Missing: {csv_path}"
    assert meta_path.exists(), f"Missing: {meta_path}"
    assert gallery_path.exists(), f"Missing: {gallery_path}"

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    return meta, rows, gallery_path

def test_semantic_pilot_counts(semantic_pilot_data):
    meta, rows, _ = semantic_pilot_data
    assert len(rows) == 50, f"Expected 50 pilot records, got {len(rows)}"
    assert meta["total_images_processed"] == 50

def test_semantic_classifications_valid(semantic_pilot_data):
    meta, rows, _ = semantic_pilot_data
    valid_classes = {"likely_garbage_negative", "likely_positive_litter", "uncertain"}

    for r in rows:
        assert r["suggested_classification"] in valid_classes
        assert 0.0 <= float(r["confidence"]) <= 1.0
        assert r["status"] == "success"
        # Validate agreement field
        expected_agreement = (r["suggested_classification"] == r["heuristic_classification"])
        actual_agreement = (r["agreement_with_heuristic"].lower() == "true")
        assert actual_agreement == expected_agreement

def test_split_and_candidate_safety(semantic_pilot_data):
    meta, rows, _ = semantic_pilot_data
    b9_csv = Path("data/manifest_out/f6_b9/garbage_negative_review_sheet.csv")
    with open(b9_csv, "r", encoding="utf-8") as f:
        b9_rows = list(csv.DictReader(f))[:50]

    for b9_r, b11_r in zip(b9_rows, rows):
        assert b11_r["candidate_id"] == b9_r["candidate_id"]
        assert b11_r["sample_id"] == b9_r["sample_id"]
        assert b11_r["group_id"] == b9_r["group_id"]
        assert b11_r["existing_split"] == b9_r["existing_split"]
        assert b11_r["file_hash"] == b9_r["file_hash"]

def test_semantic_gallery_integrity(semantic_pilot_data):
    _, rows, gallery_path = semantic_pilot_data
    with open(gallery_path, "r", encoding="utf-8") as f:
        html = f.read()

    for r in rows:
        assert r["candidate_id"] in html

    img_sources = re.findall(r'src="([^"]+)"', html)
    assert len(img_sources) == 50
    for src in img_sources:
        resolved = Path("data/manifest_out/f6_b11") / src
        assert resolved.exists(), f"Gallery image missing: {resolved}"
