import json
from pathlib import Path
from collections import defaultdict, Counter

def audit_dataset_integrity(manifest_path, name):
    print(f"\n==========================================")
    print(f"AUDITING INTEGRITY: {name} ({manifest_path})")
    print(f"==========================================")
    
    with open(manifest_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    samples = data.get("samples", [])
    print(f"Total manifest records (bounding boxes): {len(samples):,}")
    
    # 1. Image path resolution
    missing_files = []
    # 2. BBox checks
    malformed_bboxes = [] # None or len != 4
    degenerate_bboxes = [] # xmin >= xmax or ymin >= ymax or area <= 0
    out_of_bounds_bboxes = [] # outside [0, w] or [0, h]
    valid_bboxes = 0
    
    # 3. Multi-record and multi-category tracking per image
    image_records = defaultdict(list)
    image_splits = defaultdict(set)
    image_categories = defaultdict(set)
    image_hashes = {}
    hash_to_images = defaultdict(set)
    
    for s in samples:
        img_p = Path(s["absolute_path"])
        if not img_p.exists():
            missing_files.append(s["absolute_path"])
            
        w = s.get("width")
        h = s.get("height")
        bbox = s.get("bbox")
        
        if not bbox or len(bbox) != 4:
            malformed_bboxes.append((s["sample_id"], bbox))
        else:
            xmin, ymin, xmax, ymax = bbox
            if xmin >= xmax or ymin >= ymax:
                degenerate_bboxes.append((s["sample_id"], bbox))
            elif w and h and (xmin < 0 or ymin < 0 or xmax > w or ymax > h):
                out_of_bounds_bboxes.append((s["sample_id"], bbox, (w, h)))
            else:
                valid_bboxes += 1
                
        rel_img = s["image_path"]
        image_records[rel_img].append(s)
        image_splits[rel_img].add(s["split"])
        image_categories[rel_img].add(s["mapped_category"])
        
        fhash = s.get("file_hash")
        if fhash:
            image_hashes[rel_img] = fhash
            hash_to_images[fhash].add(rel_img)
            
    print(f"1. Image Path Resolution:")
    print(f"   Missing physical images: {len(missing_files)}")
    
    print(f"2. Bounding Box Geometry Integrity:")
    print(f"   Valid bounding boxes: {valid_bboxes:,} / {len(samples):,} ({round(valid_bboxes/len(samples)*100, 2)}%)")
    print(f"   Malformed (not 4 coords): {len(malformed_bboxes)}")
    print(f"   Degenerate (zero/negative area): {len(degenerate_bboxes)}")
    if degenerate_bboxes:
        print(f"   Sample degenerate: {degenerate_bboxes[:3]}")
    print(f"   Out-of-bounds (exceeding w/h): {len(out_of_bounds_bboxes)}")
    if out_of_bounds_bboxes:
        print(f"   Sample out-of-bounds: {out_of_bounds_bboxes[:3]}")
        
    unique_images = len(image_records)
    print(f"3. Image-Level & Multi-Category Analysis:")
    print(f"   Unique images in manifest: {unique_images:,}")
    multi_box_imgs = {img: recs for img, recs in image_records.items() if len(recs) > 1}
    print(f"   Images with >1 bounding box: {len(multi_box_imgs):,} ({round(len(multi_box_imgs)/unique_images*100, 1)}%)")
    multi_cat_imgs = {img: cats for img, cats in image_categories.items() if len(cats) > 1}
    print(f"   Images with >1 target category: {len(multi_cat_imgs):,} ({round(len(multi_cat_imgs)/unique_images*100, 1)}%)")
    if multi_cat_imgs:
        combos = Counter(tuple(sorted(list(c))) for c in multi_cat_imgs.values())
        print(f"   Co-occurring category combinations: {dict(combos)}")
        
    print(f"4. Split Assignment Consistency:")
    split_conflicts = {img: splits for img, splits in image_splits.items() if len(splits) > 1}
    print(f"   Images crossing multiple splits: {len(split_conflicts)}")
    
    print(f"5. Exact Hash Duplicates:")
    duplicate_hashes = {h: imgs for h, imgs in hash_to_images.items() if len(imgs) > 1}
    print(f"   Duplicate SHA-256 hashes: {len(duplicate_hashes)}")
    
    # Class breakdown by UNIQUE IMAGES vs BOUNDING BOXES
    cat_box_counts = Counter(s["mapped_category"] for s in samples)
    cat_img_counts = Counter()
    for img, cats in image_categories.items():
        for c in cats:
            cat_img_counts[c] += 1
            
    print(f"\n6. Annotation Counts vs Unique-Image Counts:")
    for cat in sorted(cat_box_counts.keys()):
        print(f"   - {cat:15s}: {cat_box_counts[cat]:,d} bounding boxes across {cat_img_counts[cat]:,d} unique images")
        
    # Split distributions
    split_box_counts = Counter(s["split"] for s in samples)
    split_img_counts = Counter()
    for img, splits in image_splits.items():
        for sp in splits:
            split_img_counts[sp] += 1
            
    print(f"\n7. Split Distributions (Boxes vs Images):")
    for sp in ["train", "val", "test"]:
        print(f"   - {sp:6s}: {split_box_counts[sp]:,d} boxes ({round(split_box_counts[sp]/len(samples)*100, 1)}%) | {split_img_counts[sp]:,d} unique images ({round(split_img_counts[sp]/unique_images*100, 1)}%)")

    return {
        "total_samples": len(samples),
        "unique_images": unique_images,
        "valid_bboxes": valid_bboxes,
        "degenerate_bboxes": len(degenerate_bboxes),
        "out_of_bounds_bboxes": len(out_of_bounds_bboxes),
        "multi_cat_imgs": len(multi_cat_imgs),
        "split_conflicts": len(split_conflicts),
        "duplicate_hashes": len(duplicate_hashes),
        "cat_box_counts": dict(cat_box_counts),
        "cat_img_counts": dict(cat_img_counts),
        "split_box_counts": dict(split_box_counts),
        "split_img_counts": dict(split_img_counts)
    }

if __name__ == "__main__":
    taco_res = audit_dataset_integrity("data/manifest_out/taco/manifest.json", "TACO")
    rdd_res = audit_dataset_integrity("data/manifest_out/rdd2022/manifest.json", "RDD2022")
