import json
from pathlib import Path
from PIL import Image, ExifTags

def investigate_taco_oob():
    taco_manifest = Path("data/manifest_out/taco/manifest.json")
    with open(taco_manifest, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    samples = data.get("samples", [])
    oob_samples = []
    
    # Check EXIF orientation tag code
    orientation_tag = None
    for tag, name in ExifTags.TAGS.items():
        if name == 'Orientation':
            orientation_tag = tag
            break

    print(f"Investigating {len(samples)} TACO samples for OOB and EXIF orientation...")
    
    checked_images = set()
    exif_findings = []
    
    for s in samples:
        bbox = s.get("bbox")
        w = s.get("width")
        h = s.get("height")
        img_p = Path(s["absolute_path"])
        
        if not bbox or not w or not h:
            continue
            
        xmin, ymin, xmax, ymax = bbox
        is_oob = (xmin < 0 or ymin < 0 or xmax > w or ymax > h)
        if is_oob:
            oob_samples.append(s)
            
        if img_p not in checked_images and is_oob:
            checked_images.add(img_p)
            try:
                with Image.open(img_p) as img:
                    raw_w, raw_h = img.size
                    exif = img.getexif()
                    orientation = exif.get(orientation_tag, None) if exif else None
                    exif_findings.append({
                        "file": str(img_p.name),
                        "manifest_dims": (w, h),
                        "pil_dims": (raw_w, raw_h),
                        "exif_orientation": orientation,
                        "sample_bbox": bbox
                    })
            except Exception as e:
                exif_findings.append({
                    "file": str(img_p.name),
                    "error": str(e)
                })

    print(f"Total TACO OOB bounding boxes: {len(oob_samples)}")
    print(f"Unique TACO images with OOB bounding boxes: {len(checked_images)}")
    print("\nSample EXIF inspection of OOB images:")
    for f in exif_findings[:10]:
        print(f"  {f['file']}: manifest_dims={f.get('manifest_dims')}, pil_dims={f.get('pil_dims')}, EXIF_orientation={f.get('exif_orientation')}, bbox={f.get('sample_bbox')}")

    # Check whether swapping width/height or EXIF orientation transposes make the bboxes valid
    resolved_by_swapped_dims = 0
    resolved_by_exif = 0
    still_oob_after_swap = 0
    
    for s in oob_samples:
        xmin, ymin, xmax, ymax = s["bbox"]
        w = s["width"]
        h = s["height"]
        # If w and h are swapped
        if 0 <= xmin and 0 <= ymin and xmax <= h and ymax <= w:
            resolved_by_swapped_dims += 1
        else:
            still_oob_after_swap += 1
            
    print(f"\nOOB Resolution Analysis:")
    print(f"  OOB boxes resolved if width and height are inverted (portrait EXIF swap): {resolved_by_swapped_dims} / {len(oob_samples)} ({round(resolved_by_swapped_dims/len(oob_samples)*100, 2)}%)")
    print(f"  OOB boxes that still exceed dimensions even after swap: {still_oob_after_swap}")

def investigate_rdd_degenerate():
    xml_p = Path("data/raw/rdd2022/Japan/train/annotations/xmls/Japan_001265.xml")
    img_p = Path("data/raw/rdd2022/Japan/train/images/Japan_001265.jpg")
    print(f"\nInvestigating RDD2022 Japan_001265...")
    print(f"  XML exists: {xml_p.exists()}, Image exists: {img_p.exists()}")
    with Image.open(img_p) as img:
        print(f"  Image size: {img.size}, mode: {img.mode}")
    with open(xml_p) as f:
        print(f"  XML content preview:\n{f.read()}")

if __name__ == "__main__":
    investigate_taco_oob()
    investigate_rdd_degenerate()
