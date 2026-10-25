import csv
import json
from pathlib import Path
import pytest

@pytest.fixture(scope="module")
def manifest_data():
    json_path = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
    csv_path = Path("data/manifest_out/f6_b6/multilabel_manifest.csv")
    card_path = Path("data/manifest_out/f6_b6/DATASET_CARD.md")
    
    assert json_path.exists(), f"Missing: {json_path}"
    assert csv_path.exists(), f"Missing: {csv_path}"
    assert card_path.exists(), f"Missing: {card_path}"
    
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        
    return data, rows

def test_manifest_files_exist_and_non_empty(manifest_data):
    data, rows = manifest_data
    assert len(data.get("samples", [])) > 0
    assert len(rows) > 0
    assert len(data["samples"]) == len(rows)
    assert len(rows) == 17339

def test_record_counts_and_reconciliation(manifest_data):
    data, rows = manifest_data
    samples = data["samples"]
    
    taco_count = sum(1 for s in samples if s["source"] == "TACO")
    rdd_count = sum(1 for s in samples if s["source"] == "RDD2022")
    
    assert taco_count == 1500
    assert rdd_count == 15839
    assert taco_count + rdd_count == 17339
    
    # Reconciliation to 18,212 source RDD2022 pairs:
    # 15,839 in manifest + 2,373 excluded non-target markings = 18,212
    meta_src = data["source_breakdown"]
    assert meta_src["RDD2022_target_defects"] == 11124
    assert meta_src["RDD2022_clean_road_negatives"] == 4715
    assert meta_src["RDD2022_excluded_unmapped_markings"] == 2373
    assert meta_src["RDD2022_target_defects"] + meta_src["RDD2022_clean_road_negatives"] + meta_src["RDD2022_excluded_unmapped_markings"] == 18212

def test_label_and_mask_consistency(manifest_data):
    data, rows = manifest_data
    for s in data["samples"]:
        lbls = s["labels"]
        masks = s["label_masks"]
        
        for cat in ["pothole", "road_damage", "garbage"]:
            val = lbls[cat]
            m = masks[cat]
            assert val in [-1, 0, 1]
            assert m in [0, 1]
            if m == 1:
                assert val in [0, 1]
            else:
                assert val == -1

def test_zero_split_leakage(manifest_data):
    data, _ = manifest_data
    splits = {"train": set(), "val": set(), "test": set()}
    for s in data["samples"]:
        splits[s["split"]].add(s["group_id"])
        
    tv = splits["train"].intersection(splits["val"])
    tt = splits["train"].intersection(splits["test"])
    vt = splits["val"].intersection(splits["test"])
    
    assert len(tv) == 0, f"Train-Val leakage: {tv}"
    assert len(tt) == 0, f"Train-Test leakage: {tt}"
    assert len(vt) == 0, f"Val-Test leakage: {vt}"

def test_co_occurrence_count(manifest_data):
    data, _ = manifest_data
    co_occur = 0
    for s in data["samples"]:
        if s["labels"]["pothole"] == 1 and s["labels"]["road_damage"] == 1:
            co_occur += 1
    assert co_occur == 1670

def test_clean_road_negatives_count(manifest_data):
    data, _ = manifest_data
    clean_cnt = 0
    for s in data["samples"]:
        if s["source"] == "RDD2022" and s["labels"]["pothole"] == 0 and s["labels"]["road_damage"] == 0:
            clean_cnt += 1
    assert clean_cnt == 4715

def test_physical_image_resolution(manifest_data):
    data, _ = manifest_data
    raw_root = Path("data/raw")
    # Verify first 100, middle 100, and last 100 images
    samples = data["samples"]
    check_subset = samples[:100] + samples[len(samples)//2 : len(samples)//2 + 100] + samples[-100:]
    for s in check_subset:
        abs_p = raw_root / s["image_path"]
        assert abs_p.exists(), f"Image does not exist: {abs_p}"
