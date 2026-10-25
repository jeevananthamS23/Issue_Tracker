import csv
import json
import os
import re
from pathlib import Path
import pytest
from scripts.screen_garbage_candidates_pilot import inspect_image_scene

@pytest.fixture(scope="module")
def pilot_data():
    f6_b10_dir = Path("data/manifest_out/f6_b10")
    csv_path = f6_b10_dir / "pilot_screening_results.csv"
    meta_path = f6_b10_dir / "pilot_screening_metadata.json"
    gallery_path = f6_b10_dir / "pilot_screening_gallery.html"

    assert csv_path.exists(), f"Missing: {csv_path}"
    assert meta_path.exists(), f"Missing: {meta_path}"
    assert gallery_path.exists(), f"Missing: {gallery_path}"

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    return meta, rows, gallery_path

def test_pilot_candidate_count(pilot_data):
    meta, rows, _ = pilot_data
    assert len(rows) == 50, f"Expected 50 pilot candidates, got {len(rows)}"
    assert meta["total_images_processed"] == 50

def test_classification_categories_valid(pilot_data):
    meta, rows, _ = pilot_data
    valid_classes = {"likely_garbage_negative", "likely_positive_litter", "uncertain"}
    
    for r in rows:
        assert r["suggested_classification"] in valid_classes, f"Invalid classification: {r['suggested_classification']}"
        assert 0.0 <= float(r["confidence"]) <= 1.0, f"Confidence out of range: {r['confidence']}"
        assert r["status"] == "success"

    # Verify counts match metadata
    class_counts = meta["classification_counts"]
    total_from_meta = sum(class_counts.values())
    assert total_from_meta == 50
    for cls in valid_classes:
        assert cls in class_counts
        assert class_counts[cls] == sum(1 for r in rows if r["suggested_classification"] == cls)

def test_candidate_preservation_and_split_safety(pilot_data):
    meta, rows, _ = pilot_data
    f6_b9_csv = Path("data/manifest_out/f6_b9/garbage_negative_review_sheet.csv")
    with open(f6_b9_csv, "r", encoding="utf-8") as f:
        b9_rows = list(csv.DictReader(f))[:50]

    for b9_r, b10_r in zip(b9_rows, rows):
        assert b10_r["candidate_id"] == b9_r["candidate_id"]
        assert b10_r["sample_id"] == b9_r["sample_id"]
        assert b10_r["group_id"] == b9_r["group_id"]
        assert b10_r["existing_split"] == b9_r["existing_split"]
        assert b10_r["file_hash"] == b9_r["file_hash"]
        assert b10_r["absolute_image_path"] == b9_r["absolute_image_path"]

def test_failure_handling_robustness():
    # Test missing file
    missing_res = inspect_image_scene("non_existent_file_path_12345.jpg")
    assert missing_res["suggested_classification"] == "uncertain"
    assert missing_res["confidence"] == 0.0
    assert missing_res["status"] == "error_file_missing"

def test_gallery_integrity(pilot_data):
    _, rows, gallery_path = pilot_data
    with open(gallery_path, "r", encoding="utf-8") as f:
        html = f.read()

    # Verify all 50 candidate IDs are in the HTML
    for r in rows:
        assert r["candidate_id"] in html

    # Verify all image sources in gallery exist on disk
    img_sources = re.findall(r'src="([^"]+)"', html)
    assert len(img_sources) == 50
    for src in img_sources:
        resolved = Path("data/manifest_out/f6_b10") / src
        assert resolved.exists(), f"Gallery image missing on disk: {resolved}"
