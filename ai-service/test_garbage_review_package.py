import csv
import json
from pathlib import Path
import pytest

@pytest.fixture(scope="module")
def review_data():
    f6_b9_dir = Path("data/manifest_out/f6_b9")
    csv_path = f6_b9_dir / "garbage_negative_review_sheet.csv"
    json_path = f6_b9_dir / "candidate_metadata.json"
    plan_path = f6_b9_dir / "GARBAGE_NEGATIVE_REVIEW_PLAN.md"
    protocol_path = f6_b9_dir / "REVIEW_PROTOCOL.md"
    gallery_path = f6_b9_dir / "review_gallery.html"
    contact_dir = f6_b9_dir / "contact_sheets"

    assert csv_path.exists(), f"Missing: {csv_path}"
    assert json_path.exists(), f"Missing: {json_path}"
    assert plan_path.exists(), f"Missing: {plan_path}"
    assert protocol_path.exists(), f"Missing: {protocol_path}"
    assert gallery_path.exists(), f"Missing: {gallery_path}"
    assert contact_dir.exists(), f"Missing: {contact_dir}"

    with open(json_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    return meta, rows, contact_dir

def test_candidate_counts(review_data):
    meta, rows, _ = review_data
    assert len(rows) == 1500
    assert meta["candidate_count"] == 1500
    assert len(meta["candidates"]) == 1500

def test_split_preservation(review_data):
    meta, rows, _ = review_data
    split_counts = {"train": 0, "val": 0, "test": 0}
    for r in rows:
        sp = r["existing_split"]
        assert sp in split_counts
        split_counts[sp] += 1

    assert split_counts["train"] == 1050
    assert split_counts["val"] == 225
    assert split_counts["test"] == 225

    # Cross-check against F6-B6 manifest
    f6_b6_manifest = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
    with open(f6_b6_manifest, "r", encoding="utf-8") as f:
        b6_data = json.load(f)
    b6_sample_to_split = {s["sample_id"]: s["split"] for s in b6_data["samples"]}

    for r in rows:
        assert b6_sample_to_split[r["sample_id"]] == r["existing_split"], f"Split changed for {r['sample_id']}"

def test_zero_split_leakage(review_data):
    meta, rows, _ = review_data
    splits = {"train": set(), "val": set(), "test": set()}
    for r in rows:
        splits[r["existing_split"]].add(r["group_id"])

    tv = splits["train"].intersection(splits["val"])
    tt = splits["train"].intersection(splits["test"])
    vt = splits["val"].intersection(splits["test"])

    assert len(tv) == 0, f"Train-Val overlap: {tv}"
    assert len(tt) == 0, f"Train-Test overlap: {tt}"
    assert len(vt) == 0, f"Val-Test overlap: {vt}"

def test_physical_image_resolution(review_data):
    meta, rows, _ = review_data
    # Check sample of candidates
    check_subset = rows[:50] + rows[750:800] + rows[-50:]
    for r in check_subset:
        abs_p = Path(r["absolute_image_path"])
        assert abs_p.exists(), f"Image does not exist: {abs_p}"

def test_review_sheet_columns(review_data):
    meta, rows, _ = review_data
    expected_cols = [
        "candidate_id",
        "sample_id",
        "group_id",
        "relative_image_path",
        "absolute_image_path",
        "existing_split",
        "width",
        "height",
        "file_hash",
        "reviewer_id",
        "review_date",
        "review_result",
        "notes"
    ]
    for col in expected_cols:
        assert col in rows[0]

    # Verify review fields are initially blank for human review
    for r in rows[:20]:
        assert r["reviewer_id"] == ""
        assert r["review_date"] == ""
        assert r["review_result"] == ""

def test_contact_sheets_count(review_data):
    _, _, contact_dir = review_data
    sheets = list(contact_dir.glob("contact_sheet_*.jpg"))
    assert len(sheets) == 15
