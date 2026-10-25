import json
from pathlib import Path
from PIL import Image, ExifTags, ImageOps

def investigate_taco_detailed():
    taco_ann_path = Path("data/raw/taco/annotations.json")
    taco_root = Path("data/raw/taco")
    
    with open(taco_ann_path, "r", encoding="utf-8") as f:
        coco = json.load(f)
        
    img_by_id = {img["id"]: img for img in coco["images"]}
    anns = coco["annotations"]
    
    orientation_tag = None
    for tag, name in ExifTags.TAGS.items():
        if name == 'Orientation':
            orientation_tag = tag
            break
            
    oob_exif_resolved = []
    oob_remaining_6 = []
    
    for ann in anns:
        img_info = img_by_id[ann["image_id"]]
        file_name = img_info["file_name"]
        coco_w = img_info["width"]
        coco_h = img_info["height"]
        bbox = ann["bbox"] # [x, y, w, h]
        
        x, y, bw, bh = bbox
        xmax = x + bw
        ymax = y + bh
        
        # Check if OOB in stated COCO dimensions
        if x < 0 or y < 0 or xmax > coco_w or ymax > coco_h:
            # Check physical file and EXIF
            img_p = taco_root / file_name
            with Image.open(img_p) as img:
                raw_w, raw_h = img.size
                exif = img.getexif()
                orient = exif.get(orientation_tag, 1) if exif else 1
                
                # Check transposed size
                img_trans = ImageOps.exif_transpose(img)
                trans_w, trans_h = img_trans.size
                
            # Check if resolved by trans_w, trans_h
            if 0 <= x and 0 <= y and xmax <= trans_w and ymax <= trans_h:
                oob_exif_resolved.append({
                    "ann_id": ann["id"],
                    "image": file_name,
                    "bbox": [x, y, xmax, ymax],
                    "coco_wh": (coco_w, coco_h),
                    "raw_pil_wh": (raw_w, raw_h),
                    "trans_wh": (trans_w, trans_h),
                    "orientation": orient
                })
            else:
                oob_remaining_6.append({
                    "ann_id": ann["id"],
                    "image": file_name,
                    "bbox": [x, y, xmax, ymax],
                    "coco_wh": (coco_w, coco_h),
                    "raw_pil_wh": (raw_w, raw_h),
                    "trans_wh": (trans_w, trans_h),
                    "orientation": orient,
                    "overshoot": {
                        "dx": max(0, xmax - trans_w),
                        "dy": max(0, ymax - trans_h)
                    }
                })

    print(f"=== TASK 2: TACO EXIF & BBOX INVESTIGATION ===")
    print(f"Total annotations in TACO: {len(anns):,}")
    print(f"Total OOB in stated COCO dimensions: {len(oob_exif_resolved) + len(oob_remaining_6)}")
    print(f"OOB annotations 100% resolved by EXIF orientation transpose: {len(oob_exif_resolved)} ({round(len(oob_exif_resolved)/(len(oob_exif_resolved)+len(oob_remaining_6))*100, 2)}%)")
    print(f"Remaining cases exceeding transposed bounds: {len(oob_remaining_6)}")
    
    print("\n--- Representative EXIF-Resolved Cases ---")
    for r in oob_exif_resolved[:3]:
        print(f"Ann {r['ann_id']} ({r['image']}):")
        print(f"  bbox=[x1:{r['bbox'][0]:.1f}, y1:{r['bbox'][1]:.1f}, x2:{r['bbox'][2]:.1f}, y2:{r['bbox'][3]:.1f}]")
        print(f"  COCO stated (w,h): {r['coco_wh']}")
        print(f"  Raw PIL (w,h):     {r['raw_pil_wh']}, EXIF Orientation: {r['orientation']}")
        print(f"  Transposed (w,h):  {r['trans_wh']} -> BBox lies strictly within [0, {r['trans_wh'][0]}] x [0, {r['trans_wh'][1]}]!")

    print("\n--- Detailed Audit of Remaining Cases ---")
    for r in oob_remaining_6:
        print(f"Ann {r['ann_id']} ({r['image']}):")
        print(f"  bbox=[x1:{r['bbox'][0]:.1f}, y1:{r['bbox'][1]:.1f}, x2:{r['bbox'][2]:.1f}, y2:{r['bbox'][3]:.1f}]")
        print(f"  Transposed (w,h): {r['trans_wh']}, EXIF Orientation: {r['orientation']}")
        print(f"  Overshoot: dx={r['overshoot']['dx']:.1f}px, dy={r['overshoot']['dy']:.1f}px")

if __name__ == "__main__":
    investigate_taco_detailed()
