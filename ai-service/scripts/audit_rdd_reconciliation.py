import os
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from collections import defaultdict, Counter

def audit_rdd2022():
    rdd_root = Path("data/raw/rdd2022")
    manifest_path = Path("data/manifest_out/rdd2022/manifest.json")
    
    # 1. Extracted images and XMLs
    india_xmls = list((rdd_root / "India/train/annotations/xmls").glob("*.xml"))
    india_imgs = list((rdd_root / "India/train/images").glob("*.jpg"))
    japan_xmls = list((rdd_root / "Japan/train/annotations/xmls").glob("*.xml"))
    japan_imgs = list((rdd_root / "Japan/train/images").glob("*.jpg"))
    
    all_xmls = india_xmls + japan_xmls
    all_imgs = india_imgs + japan_imgs
    
    print(f"RDD2022 Total Extracted XMLs: {len(all_xmls)} (India: {len(india_xmls)}, Japan: {len(japan_xmls)})")
    print(f"RDD2022 Total Extracted Images: {len(all_imgs)} (India: {len(india_imgs)}, Japan: {len(japan_imgs)})")
    
    # Check parseability and object counts
    parse_errors = []
    xml_data = {} # xml_path -> {objects, filename, width, height, has_target}
    raw_label_counts = Counter()
    canonical_counts = Counter()
    xml_with_zero_objects = []
    xml_with_only_unmapped = []
    xml_with_target_objects = []
    
    TARGET_MAPPING = {
        "d40": "pothole",
        "d00": "road_damage",
        "d10": "road_damage",
        "d20": "road_damage",
        "d0w0": "road_damage"
    }
    
    for xf in all_xmls:
        try:
            tree = ET.parse(xf)
            root = tree.getroot()
            objs = root.findall(".//object")
            size_elem = root.find("size")
            w = int(size_elem.findtext("width")) if size_elem is not None and size_elem.findtext("width") else None
            h = int(size_elem.findtext("height")) if size_elem is not None and size_elem.findtext("height") else None
            
            parsed_objs = []
            has_target = False
            for obj in objs:
                raw_name = obj.findtext("name", "").strip()
                raw_lower = raw_name.lower()
                raw_label_counts[raw_name] += 1
                
                bndbox = obj.find("bndbox")
                bbox = None
                if bndbox is not None:
                    try:
                        xmin = int(float(bndbox.findtext("xmin", 0)))
                        ymin = int(float(bndbox.findtext("ymin", 0)))
                        xmax = int(float(bndbox.findtext("xmax", 0)))
                        ymax = int(float(bndbox.findtext("ymax", 0)))
                        bbox = [xmin, ymin, xmax, ymax]
                    except Exception:
                        pass
                
                cat = TARGET_MAPPING.get(raw_lower)
                if cat:
                    canonical_counts[cat] += 1
                    has_target = True
                
                parsed_objs.append({
                    "raw_name": raw_name,
                    "canonical": cat,
                    "bbox": bbox
                })
            
            xml_data[xf] = {
                "objs": parsed_objs,
                "w": w,
                "h": h,
                "has_target": has_target
            }
            
            if len(parsed_objs) == 0:
                xml_with_zero_objects.append(xf)
            elif not has_target:
                xml_with_only_unmapped.append(xf)
            else:
                xml_with_target_objects.append(xf)
                
        except Exception as e:
            parse_errors.append((xf, str(e)))
            
    print(f"Parse errors: {len(parse_errors)}")
    print(f"XMLs with 0 objects: {len(xml_with_zero_objects)}")
    print(f"XMLs with ONLY unmapped objects (e.g. D44, D50, etc.): {len(xml_with_only_unmapped)}")
    print(f"XMLs with at least one TARGET category (pothole/road_damage): {len(xml_with_target_objects)}")
    print(f"Sum check: {len(xml_with_zero_objects)} + {len(xml_with_only_unmapped)} + {len(xml_with_target_objects)} = {len(xml_with_zero_objects) + len(xml_with_only_unmapped) + len(xml_with_target_objects)}")
    
    # Check manifest
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    manifest_samples = manifest.get("samples", [])
    manifest_imgs = set(s["image_path"] for s in manifest_samples)
    print(f"Manifest total records (bounding boxes): {len(manifest_samples)}")
    print(f"Manifest unique images: {len(manifest_imgs)}")
    print(f"Difference (extracted images - manifest images): {len(all_imgs) - len(manifest_imgs)}")
    print(f"Exact match check: does {len(xml_with_target_objects)} equal {len(manifest_imgs)}? -> {len(xml_with_target_objects) == len(manifest_imgs)}")
    
    # Defect codes breakdown
    print("\nRDD2022 Raw Label Counts:")
    for lbl, cnt in raw_label_counts.most_common():
        canon = TARGET_MAPPING.get(lbl.lower(), "UNMAPPED")
        print(f"  {lbl:10s} -> {canon:12s}: {cnt:,} occurrences")
        
    print("\nRDD2022 Canonical Category Box Counts:")
    for cat, cnt in canonical_counts.most_common():
        print(f"  {cat:15s}: {cnt:,} boxes")

    return {
        "all_xmls_count": len(all_xmls),
        "all_imgs_count": len(all_imgs),
        "parse_errors": parse_errors,
        "zero_obj_count": len(xml_with_zero_objects),
        "only_unmapped_count": len(xml_with_only_unmapped),
        "target_obj_count": len(xml_with_target_objects),
        "manifest_unique_imgs": len(manifest_imgs),
        "manifest_samples_count": len(manifest_samples),
        "raw_label_counts": dict(raw_label_counts),
        "canonical_counts": dict(canonical_counts),
        "xml_with_only_unmapped_sample": [str(x.relative_to(rdd_root)) for x in xml_with_only_unmapped[:5]]
    }

if __name__ == "__main__":
    audit_rdd2022()
