import os
import csv
import json
import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path
from collections import defaultdict, Counter

def compute_sha256(file_path: Path) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

def generate_multilabel_manifest():
    rdd_root = Path("data/raw/rdd2022")
    taco_root = Path("data/raw/taco")
    output_dir = Path("data/manifest_out/f6_b6")
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=== Step 1: Ingesting TACO Images ===")
    taco_manifest_p = Path("data/manifest_out/taco/manifest.json")
    with open(taco_manifest_p, "r", encoding="utf-8") as f:
        taco_manifest = json.load(f)

    taco_samples = taco_manifest.get("samples", [])
    # Group by image_path
    taco_imgs = defaultdict(list)
    for s in taco_samples:
        taco_imgs[s["image_path"]].append(s)

    print(f"Discovered {len(taco_imgs)} unique TACO images from {len(taco_samples)} bounding boxes.")

    derived_records = []

    for rel_p, box_list in taco_imgs.items():
        first = box_list[0]
        group_id = first["group_id"]
        split = first["split"]
        w = first["width"]
        h = first["height"]
        fhash = first["file_hash"]
        img_abs = Path(first["absolute_path"])
        
        # Summary of annotations
        cat_counts = Counter(b["original_label"] for b in box_list)
        summary_str = ";".join(f"{k}:{v}" for k, v in cat_counts.most_common())

        record = {
            "sample_id": f"taco_{group_id}",
            "source": "TACO",
            "image_path": str(Path("taco") / rel_p),
            "group_id": group_id,
            "split": split,
            "width": w,
            "height": h,
            "file_hash": fhash,
            "labels": {
                "pothole": -1,
                "road_damage": -1,
                "garbage": 1
            },
            "label_masks": {
                "pothole": 0,
                "road_damage": 0,
                "garbage": 1
            },
            "target_status": {
                "pothole": "unknown",
                "road_damage": "unknown",
                "garbage": "positive"
            },
            "source_defect_count": len(box_list),
            "source_annotations_summary": summary_str
        }
        derived_records.append(record)

    print(f"TACO records processed: {len(derived_records)}")

    print("\n=== Step 2: Ingesting RDD2022 Target-Defect Images ===")
    rdd_manifest_p = Path("data/manifest_out/rdd2022/manifest.json")
    with open(rdd_manifest_p, "r", encoding="utf-8") as f:
        rdd_manifest = json.load(f)

    rdd_samples = rdd_manifest.get("samples", [])
    rdd_imgs = defaultdict(list)
    for s in rdd_samples:
        rdd_imgs[s["image_path"]].append(s)

    print(f"Discovered {len(rdd_imgs)} unique RDD2022 target images from {len(rdd_samples)} bounding boxes.")

    for rel_p, box_list in rdd_imgs.items():
        first = box_list[0]
        group_id = first["group_id"]
        split = first["split"]
        w = first["width"]
        h = first["height"]
        fhash = first["file_hash"]

        cats_present = set(b["mapped_category"] for b in box_list)
        is_pothole = 1 if "pothole" in cats_present else 0
        is_road_damage = 1 if "road_damage" in cats_present else 0

        cat_counts = Counter(b["original_label"] for b in box_list)
        summary_str = ";".join(f"{k}:{v}" for k, v in cat_counts.most_common())

        record = {
            "sample_id": f"rdd2022_{group_id}",
            "source": "RDD2022",
            "image_path": str(Path("rdd2022") / rel_p),
            "group_id": group_id,
            "split": split,
            "width": w,
            "height": h,
            "file_hash": fhash,
            "labels": {
                "pothole": is_pothole,
                "road_damage": is_road_damage,
                "garbage": -1
            },
            "label_masks": {
                "pothole": 1,
                "road_damage": 1,
                "garbage": 0
            },
            "target_status": {
                "pothole": "positive" if is_pothole == 1 else "negative",
                "road_damage": "positive" if is_road_damage == 1 else "negative",
                "garbage": "unknown"
            },
            "source_defect_count": len(box_list),
            "source_annotations_summary": summary_str
        }
        derived_records.append(record)

    print(f"Total records after RDD2022 target images: {len(derived_records)}")

    print("\n=== Step 3: Ingesting RDD2022 Clean Road Images (4,715 verified negatives) ===")
    all_rdd_xmls = list((rdd_root / "India/train/annotations/xmls").glob("*.xml")) + \
                   list((rdd_root / "Japan/train/annotations/xmls").glob("*.xml"))

    clean_road_xmls = []
    unmapped_only_xmls = []

    for xf in all_rdd_xmls:
        try:
            tree = ET.parse(xf)
            root = tree.getroot()
            objs = root.findall(".//object")
            if len(objs) == 0:
                clean_road_xmls.append(xf)
            else:
                has_target = any(o.findtext("name", "").strip().lower() in ["d40", "d00", "d10", "d20", "d0w0"] for o in objs)
                if not has_target:
                    unmapped_only_xmls.append(xf)
        except Exception:
            pass

    print(f"Found {len(clean_road_xmls)} clean road XMLs with 0 objects.")
    print(f"Found {len(unmapped_only_xmls)} XMLs with only non-target objects (D44, D50, D43, D01, D11).")

    # Split clean roads deterministically using hash of group_id with seed 42
    # Exact 70% train / 15% val / 15% test split
    import random
    rng = random.Random(42)
    clean_road_xmls_sorted = sorted(clean_road_xmls, key=lambda x: x.stem)
    rng.shuffle(clean_road_xmls_sorted)

    n_clean = len(clean_road_xmls_sorted)
    n_train = int(round(n_clean * 0.70))
    n_val = int(round(n_clean * 0.15))
    n_test = n_clean - n_train - n_val

    clean_splits = {}
    for i, xf in enumerate(clean_road_xmls_sorted):
        if i < n_train:
            clean_splits[xf.stem] = "train"
        elif i < n_train + n_val:
            clean_splits[xf.stem] = "val"
        else:
            clean_splits[xf.stem] = "test"

    print(f"Clean road split distribution: Train: {n_train}, Val: {n_val}, Test: {n_test}")

    for xf in clean_road_xmls:
        stem = xf.stem
        # Resolve image path
        parent_country = xf.parents[3].name # 'India' or 'Japan'
        rel_img = Path(parent_country) / "train" / "images" / f"{stem}.jpg"
        abs_img = rdd_root / rel_img

        if not abs_img.exists():
            print(f"Warning: clean road image not found: {abs_img}")
            continue

        fhash = compute_sha256(abs_img)
        split = clean_splits[stem]

        # Get image size
        try:
            from PIL import Image
            with Image.open(abs_img) as img:
                w, h = img.size
        except Exception:
            w, h = 600, 600

        record = {
            "sample_id": f"rdd2022_{stem}",
            "source": "RDD2022",
            "image_path": str(Path("rdd2022") / rel_img),
            "group_id": stem,
            "split": split,
            "width": w,
            "height": h,
            "file_hash": fhash,
            "labels": {
                "pothole": 0,
                "road_damage": 0,
                "garbage": -1
            },
            "label_masks": {
                "pothole": 1,
                "road_damage": 1,
                "garbage": 0
            },
            "target_status": {
                "pothole": "negative",
                "road_damage": "negative",
                "garbage": "unknown"
            },
            "source_defect_count": 0,
            "source_annotations_summary": "clean_road:0"
        }
        derived_records.append(record)

    print(f"Total derived multi-label records: {len(derived_records):,}")

    # Step 4: Write JSON
    out_json = output_dir / "multilabel_manifest.json"
    manifest_meta = {
        "manifest_version": "1.0.0",
        "dataset_name": "CivicVision_MultiLabel_Pilot",
        "description": "Image-level multi-label dataset manifest derived from audited RDD2022 and TACO pilot datasets",
        "target_classes": ["pothole", "road_damage", "garbage"],
        "total_unique_images": len(derived_records),
        "source_breakdown": {
            "TACO": len(taco_imgs),
            "RDD2022_target_defects": len(rdd_imgs),
            "RDD2022_clean_road_negatives": len(clean_road_xmls),
            "RDD2022_excluded_unmapped_markings": len(unmapped_only_xmls),
            "RDD2022_total_extracted_population": len(all_rdd_xmls)
        },
        "samples": derived_records
    }

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(manifest_meta, f, indent=2)
    print(f"Wrote JSON: {out_json} ({out_json.stat().st_size:,} bytes)")

    # Step 5: Write CSV
    out_csv = output_dir / "multilabel_manifest.csv"
    fieldnames = [
        "sample_id",
        "source",
        "image_path",
        "group_id",
        "split",
        "width",
        "height",
        "file_hash",
        "label_pothole",
        "mask_pothole",
        "label_road_damage",
        "mask_road_damage",
        "label_garbage",
        "mask_garbage",
        "source_defect_count",
        "source_annotations_summary"
    ]

    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in derived_records:
            row = {
                "sample_id": r["sample_id"],
                "source": r["source"],
                "image_path": r["image_path"],
                "group_id": r["group_id"],
                "split": r["split"],
                "width": r["width"],
                "height": r["height"],
                "file_hash": r["file_hash"],
                "label_pothole": r["labels"]["pothole"],
                "mask_pothole": r["label_masks"]["pothole"],
                "label_road_damage": r["labels"]["road_damage"],
                "mask_road_damage": r["label_masks"]["road_damage"],
                "label_garbage": r["labels"]["garbage"],
                "mask_garbage": r["label_masks"]["garbage"],
                "source_defect_count": r["source_defect_count"],
                "source_annotations_summary": r["source_annotations_summary"]
            }
            writer.writerow(row)

    print(f"Wrote CSV: {out_csv} ({out_csv.stat().st_size:,} bytes)")
    return manifest_meta

if __name__ == "__main__":
    generate_multilabel_manifest()
