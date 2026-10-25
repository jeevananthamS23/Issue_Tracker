import csv
import json
import random
import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path
from collections import defaultdict, Counter
from PIL import Image

def audit_manifest_and_source_agreement():
    json_path = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
    csv_path = Path("data/manifest_out/f6_b6/multilabel_manifest.csv")
    raw_root = Path("data/raw")
    taco_ann_path = Path("data/raw/taco/annotations.json")
    
    print("=== TASK 1: MANIFEST INTEGRITY & RECOMPUTATION ===")
    with open(json_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
        
    samples = meta["samples"]
    print(f"Total samples in JSON: {len(samples):,}")
    
    with open(csv_path, "r", encoding="utf-8") as f:
        csv_rows = list(csv.DictReader(f))
    print(f"Total rows in CSV: {len(csv_rows):,}")
    assert len(samples) == len(csv_rows)
    
    # 1. Source and split recomputation
    source_counts = Counter(s["source"] for s in samples)
    split_counts = Counter(s["split"] for s in samples)
    source_split_counts = Counter((s["source"], s["split"]) for s in samples)
    
    print("\nSource Counts:")
    for src, cnt in source_counts.items():
        print(f"  {src}: {cnt:,} ({round(cnt/len(samples)*100, 2)}%)")
        
    print("\nSplit Counts:")
    for sp in ["train", "val", "test"]:
        print(f"  {sp}: {split_counts[sp]:,} ({round(split_counts[sp]/len(samples)*100, 2)}%)")
        
    print("\nSource x Split Counts:")
    for (src, sp), cnt in sorted(source_split_counts.items()):
        print(f"  {src} x {sp}: {cnt:,}")

    # 2. Recompute Label & Mask Distributions
    label_dist = {cat: Counter(s["labels"][cat] for s in samples) for cat in ["pothole", "road_damage", "garbage"]}
    mask_dist = {cat: Counter(s["label_masks"][cat] for s in samples) for cat in ["pothole", "road_damage", "garbage"]}
    
    print("\nLabel and Mask Distributions:")
    for cat in ["pothole", "road_damage", "garbage"]:
        print(f"  Category: {cat}")
        print(f"    Positive (+1): {label_dist[cat][1]:,}")
        print(f"    Negative ( 0): {label_dist[cat][0]:,}")
        print(f"    Unknown  (-1): {label_dist[cat][-1]:,}")
        print(f"    Mask Supervised (1): {mask_dist[cat][1]:,}")
        print(f"    Mask Masked-out (0): {mask_dist[cat][0]:,}")

    # 3. Verify Decodability of every referenced image
    print("\nVerifying Image Existence and PIL decodability (sampling check)...")
    corrupt_images = []
    # Test all 1,500 TACO images + 1,500 sample RDD2022 images to be fast
    rng = random.Random(42)
    sample_to_decode = [s for s in samples if s["source"] == "TACO"] + rng.sample([s for s in samples if s["source"] == "RDD2022"], 2000)
    for s in sample_to_decode:
        abs_p = raw_root / s["image_path"]
        if not abs_p.exists():
            corrupt_images.append((s["sample_id"], "MISSING"))
        else:
            try:
                with Image.open(abs_p) as img:
                    img.verify()
            except Exception as e:
                corrupt_images.append((s["sample_id"], str(e)))
                
    print(f"Decoded {len(sample_to_decode)} sample images across sources. Failures: {len(corrupt_images)}")
    assert len(corrupt_images) == 0

    # 4. Cross-check manifest labels against raw source annotations
    print("\nCross-checking Manifest against Raw Annotations for 500 random samples...")
    check_sample = rng.sample(samples, 500)
    mismatches = []
    
    # Load TACO COCO annotations index
    with open(taco_ann_path, "r", encoding="utf-8") as f:
        taco_coco = json.load(f)
    taco_img_to_anns = defaultdict(list)
    for ann in taco_coco["annotations"]:
        taco_img_to_anns[ann["image_id"]].append(ann)
    taco_file_to_id = {img["file_name"].replace("/", "\\"): img["id"] for img in taco_coco["images"]}
    # Also add forward slash variant
    taco_file_to_id.update({img["file_name"].replace("\\", "/"): img["id"] for img in taco_coco["images"]})

    for s in check_sample:
        src = s["source"]
        if src == "RDD2022":
            # Find XML
            rel_img = Path(s["image_path"]).relative_to("rdd2022") # India/train/images/India_000005.jpg
            country = rel_img.parts[0]
            stem = rel_img.stem
            xml_p = raw_root / "rdd2022" / country / "train" / "annotations" / "xmls" / f"{stem}.xml"
            
            if not xml_p.exists():
                mismatches.append((s["sample_id"], "XML not found"))
                continue
                
            tree = ET.parse(xml_p)
            root = tree.getroot()
            objs = root.findall(".//object")
            names = [o.findtext("name", "").strip().lower() for o in objs]
            
            raw_pothole = 1 if "d40" in names else 0
            raw_road_damage = 1 if any(k in names for k in ["d00", "d10", "d20", "d0w0"]) else 0
            
            if s["labels"]["pothole"] != raw_pothole:
                mismatches.append((s["sample_id"], f"Pothole mismatch: manifest={s['labels']['pothole']}, raw={raw_pothole}"))
            if s["labels"]["road_damage"] != raw_road_damage:
                mismatches.append((s["sample_id"], f"Road damage mismatch: manifest={s['labels']['road_damage']}, raw={raw_road_damage}"))
            if s["labels"]["garbage"] != -1 or s["label_masks"]["garbage"] != 0:
                mismatches.append((s["sample_id"], "Garbage should be -1 and mask 0 in RDD2022"))
                
        elif src == "TACO":
            rel_img = Path(s["image_path"]).relative_to("taco")
            # Lookup in COCO
            str_p1 = str(rel_img).replace("/", "\\")
            str_p2 = str(rel_img).replace("\\", "/")
            img_id = taco_file_to_id.get(str_p1) or taco_file_to_id.get(str_p2)
            if img_id is None:
                mismatches.append((s["sample_id"], f"TACO image not found in COCO images: {rel_img}"))
                continue
            anns = taco_img_to_anns.get(img_id, [])
            if len(anns) == 0:
                mismatches.append((s["sample_id"], "TACO image has 0 annotations in COCO"))
            if s["labels"]["garbage"] != 1 or s["label_masks"]["garbage"] != 1:
                mismatches.append((s["sample_id"], "Garbage should be 1 and mask 1 in TACO"))
            if s["labels"]["pothole"] != -1 or s["label_masks"]["pothole"] != 0:
                mismatches.append((s["sample_id"], "Pothole should be -1 and mask 0 in TACO"))
            if s["labels"]["road_damage"] != -1 or s["label_masks"]["road_damage"] != 0:
                mismatches.append((s["sample_id"], "Road damage should be -1 and mask 0 in TACO"))
                
    print(f"Checked 500 samples against raw XML/COCO ground truth. Mismatches: {len(mismatches)}")
    assert len(mismatches) == 0

if __name__ == "__main__":
    audit_manifest_and_source_agreement()
