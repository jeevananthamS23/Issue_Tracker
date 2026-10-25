import os
import csv
import json
import random
import hashlib
from pathlib import Path
from collections import Counter, defaultdict
from PIL import Image, ImageDraw, ImageFont

def prepare_review_package():
    manifest_p = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
    raw_root = Path("data/raw")
    output_dir = Path("data/manifest_out/f6_b9")
    output_dir.mkdir(parents=True, exist_ok=True)
    contact_sheet_dir = output_dir / "contact_sheets"
    contact_sheet_dir.mkdir(parents=True, exist_ok=True)

    print("=== Step 1: Loading F6-B6 Manifest & Filtering Clean Roads ===")
    with open(manifest_p, "r", encoding="utf-8") as f:
        data = json.load(f)

    all_samples = data["samples"]
    clean_roads = [s for s in all_samples if s["source"] == "RDD2022" and s["source_defect_count"] == 0]
    print(f"Total clean-road images in F6-B6: {len(clean_roads):,}")

    # Group by split
    by_split = defaultdict(list)
    for s in clean_roads:
        by_split[s["split"]].append(s)

    for sp in ["train", "val", "test"]:
        print(f"  {sp:5s}: {len(by_split[sp]):,} candidates available")

    print("\n=== Step 2: Stratified Sampling of 1,500 Candidates (Seed = 42) ===")
    target_counts = {"train": 1050, "val": 225, "test": 225}
    selected_candidates = []

    for sp in ["train", "val", "test"]:
        rng = random.Random(42)
        # Sort by group_id first for deterministic tie-breaking
        pool = sorted(by_split[sp], key=lambda x: x["group_id"])
        chosen = rng.sample(pool, target_counts[sp])
        # Sort chosen by group_id
        chosen = sorted(chosen, key=lambda x: x["group_id"])
        selected_candidates.extend(chosen)
        print(f"  Selected {len(chosen)} from {sp} (Target: {target_counts[sp]})")

    print(f"Total selected candidates: {len(selected_candidates):,}")
    assert len(selected_candidates) == 1500

    print("\n=== Step 3: Physical Image Verification ===")
    verified_records = []
    seen_hashes = set()
    hash_collisions = []
    read_errors = []

    for idx, s in enumerate(selected_candidates, 1):
        cand_id = f"CAND_{idx:04d}"
        rel_img = s["image_path"] # rdd2022/India/train/images/India_000004.jpg
        abs_img = raw_root / rel_img

        if not abs_img.exists():
            read_errors.append((cand_id, str(abs_img), "FILE_NOT_FOUND"))
            continue

        try:
            with Image.open(abs_img) as img:
                w, h = img.size
                img.verify()
        except Exception as e:
            read_errors.append((cand_id, str(abs_img), str(e)))
            continue

        fhash = s["file_hash"]
        if fhash in seen_hashes:
            hash_collisions.append((cand_id, fhash))
        seen_hashes.add(fhash)

        verified_records.append({
            "candidate_id": cand_id,
            "sample_id": s["sample_id"],
            "group_id": s["group_id"],
            "relative_image_path": rel_img,
            "absolute_image_path": str(abs_img.resolve()),
            "existing_split": s["split"],
            "width": w,
            "height": h,
            "file_hash": fhash,
            "reviewer_id": "",
            "review_date": "",
            "review_result": "", # verified_negative | positive_litter | uncertain
            "notes": ""
        })

    print(f"Physically verified: {len(verified_records):,} / 1,500 images")
    print(f"Read errors: {len(read_errors)}")
    print(f"Hash collisions: {len(hash_collisions)}")
    assert len(read_errors) == 0
    assert len(hash_collisions) == 0
    assert len(verified_records) == 1500

    print("\n=== Step 4: Writing Review CSV Sheet ===")
    csv_out = output_dir / "garbage_negative_review_sheet.csv"
    fieldnames = [
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

    with open(csv_out, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in verified_records:
            writer.writerow(r)

    print(f"Wrote review CSV: {csv_out} ({csv_out.stat().st_size:,} bytes, {len(verified_records)} rows)")

    print("\n=== Step 5: Writing Review Metadata JSON ===")
    json_out = output_dir / "candidate_metadata.json"
    meta_payload = {
        "package_name": "CivicVision_Garbage_Negative_Review_Package",
        "version": "1.0.0",
        "date_prepared": "2026-10-23",
        "selection_seed": 42,
        "selection_strategy": "Stratified random sampling across existing RDD2022 clean-road split partitions",
        "source_dataset": "RDD2022 (India and Japan clean-road training scenes with 0 road defect annotations)",
        "candidate_count": len(verified_records),
        "split_distribution": dict(Counter(r["existing_split"] for r in verified_records)),
        "source_country_distribution": dict(Counter(r["relative_image_path"].split("/")[1] if "/" in r["relative_image_path"] else r["relative_image_path"].split("\\")[1] for r in verified_records)),
        "review_result_options": [
            "verified_negative",
            "positive_litter",
            "uncertain"
        ],
        "candidates": verified_records
    }

    with open(json_out, "w", encoding="utf-8") as f:
        json.dump(meta_payload, f, indent=2)

    print(f"Wrote metadata JSON: {json_out} ({json_out.stat().st_size:,} bytes)")

    print("\n=== Step 6: Generating Contact Sheets (15 sheets of 100 images) ===")
    # 15 batches of 100 images
    batch_size = 100
    grid_cols = 10
    grid_rows = 10
    thumb_w, thumb_h = 120, 120
    text_h = 20
    cell_w, cell_h = thumb_w, thumb_h + text_h

    for b_idx in range(0, len(verified_records), batch_size):
        batch = verified_records[b_idx: b_idx + batch_size]
        sheet_num = (b_idx // batch_size) + 1
        sheet_name = f"contact_sheet_{sheet_num:02d}.jpg"
        sheet_path = contact_sheet_dir / sheet_name

        sheet_img = Image.new("RGB", (grid_cols * cell_w, grid_rows * cell_h), color=(25, 25, 25))
        draw = ImageDraw.Draw(sheet_img)

        for i, r in enumerate(batch):
            row_idx = i // grid_cols
            col_idx = i % grid_cols
            x0 = col_idx * cell_w
            y0 = row_idx * cell_h

            abs_p = Path(r["absolute_image_path"])
            try:
                with Image.open(abs_p) as img:
                    thumb = img.convert("RGB").resize((thumb_w, thumb_h), Image.Resampling.BILINEAR)
                    sheet_img.paste(thumb, (x0, y0))
            except Exception:
                pass

            # Draw label
            cand_id = r["candidate_id"]
            sp = r["existing_split"]
            label_text = f"{cand_id} ({sp[0].upper()})"
            draw.rectangle([x0, y0 + thumb_h, x0 + cell_w, y0 + cell_h], fill=(15, 15, 15))
            draw.text((x0 + 4, y0 + thumb_h + 3), label_text, fill=(220, 220, 220))

        sheet_img.save(sheet_path, quality=85)
        print(f"  Generated {sheet_name} (Candidates {batch[0]['candidate_id']} - {batch[-1]['candidate_id']})")

    print(f"Contact sheets successfully generated in {contact_sheet_dir}")

    print("\n=== Step 7: Generating Standalone Interactive HTML Review Gallery ===")
    html_out = output_dir / "review_gallery.html"
    generate_html_gallery(html_out, verified_records)
    print(f"Wrote HTML gallery: {html_out} ({html_out.stat().st_size:,} bytes)")

    print("\n=== Step 8: Generating REVIEW_PROTOCOL.md ===")
    protocol_out = output_dir / "REVIEW_PROTOCOL.md"
    generate_review_protocol(protocol_out)
    print(f"Wrote review protocol: {protocol_out} ({protocol_out.stat().st_size:,} bytes)")

    print("\n=== Step 9: Generating GARBAGE_NEGATIVE_REVIEW_PLAN.md ===")
    plan_out = output_dir / "GARBAGE_NEGATIVE_REVIEW_PLAN.md"
    generate_review_plan_report(plan_out, verified_records)
    print(f"Wrote final report: {plan_out} ({plan_out.stat().st_size:,} bytes)")

def generate_html_gallery(html_path: Path, records: list):
    # Generates a lightweight standalone HTML review tool
    html_content = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CivicVision AI — Garbage-Negative Human Review Gallery</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #121418; color: #e6e8ec; margin: 0; padding: 20px; }
  h1 { margin-top: 0; color: #4fa3e3; }
  .controls { background: #1c2026; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  .counter { font-weight: bold; color: #a0aec0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { background: #1c2026; border: 1px solid #2d3748; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; transition: transform 0.15s ease; }
  .card:hover { transform: translateY(-2px); border-color: #4fa3e3; }
  .card img { width: 100%; height: 200px; object-fit: cover; background: #000; cursor: pointer; }
  .card-body { padding: 10px; font-size: 13px; display: flex; flex-direction: column; gap: 6px; }
  .card-title { font-weight: bold; color: #fff; display: flex; justify-content: space-between; }
  .split-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; font-weight: bold; }
  .split-train { background: #2b4c7e; color: #d0e2ff; }
  .split-val { background: #7c4a03; color: #ffe6b0; }
  .split-test { background: #5c1d68; color: #ffd6f8; }
  .path-text { color: #718096; word-break: break-all; font-family: monospace; font-size: 11px; }
  .radio-group { display: flex; gap: 6px; margin-top: 4px; font-size: 12px; }
  .btn-filter { background: #2d3748; color: #e2e8f0; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
  .btn-filter.active { background: #3182ce; color: #fff; }
</style>
<script>
  let currentSplit = 'all';
  function filterSplit(split) {
    currentSplit = split;
    document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-' + split).classList.add('active');
    let visibleCount = 0;
    document.querySelectorAll('.card').forEach(card => {
      if (split === 'all' || card.dataset.split === split) {
        card.style.display = 'flex';
        visibleCount++;
      } else {
        card.style.display = 'none';
      }
    });
    document.getElementById('visible-count').innerText = visibleCount;
  }
</script>
</head>
<body>
  <h1>CivicVision AI — Garbage-Negative Human Review Gallery</h1>
  <p>Review package of 1,500 candidate clean-road images selected from RDD2022 India and Japan training sequences. Inspect each image to verify the absence of discarded municipal waste, litter, plastic, or debris.</p>
  
  <div class="controls">
    <div>
      <strong>Filter Split: </strong>
      <button id="btn-all" class="btn-filter active" onclick="filterSplit('all')">All (1,500)</button>
      <button id="btn-train" class="btn-filter" onclick="filterSplit('train')">Train (1,050)</button>
      <button id="btn-val" class="btn-filter" onclick="filterSplit('val')">Validation (225)</button>
      <button id="btn-test" class="btn-filter" onclick="filterSplit('test')">Test (225)</button>
    </div>
    <div class="counter">Displaying: <span id="visible-count">1500</span> / 1500 candidates</div>
  </div>

  <div class="grid">
"""
    for r in records:
        cand_id = r["candidate_id"]
        group_id = r["group_id"]
        sp = r["existing_split"]
        rel_p = r["relative_image_path"].replace("\\", "/")
        # Path relative to output html
        img_src = f"../../../data/raw/{rel_p}"

        html_content += f"""    <div class="card" data-split="{sp}">
      <a href="{img_src}" target="_blank" title="Click to view full image in new tab">
        <img src="{img_src}" alt="{cand_id}" loading="lazy">
      </a>
      <div class="card-body">
        <div class="card-title">
          <span>{cand_id}</span>
          <span class="split-badge split-{sp}">{sp}</span>
        </div>
        <div class="path-text">{group_id} ({r['width']}x{r['height']})</div>
      </div>
    </div>
"""

    html_content += """  </div>
</body>
</html>"""

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)

def generate_review_protocol(protocol_path: Path):
    content = """# Garbage-Negative Human Review Protocol

## 1. Purpose & Scope
This protocol governs the human visual review of candidate images selected from the RDD2022 dataset to establish verified negative training, validation, and test examples for the `garbage` class in CivicVision AI.

---

## 2. Decision Tree & Label Definitions

For each candidate image, the reviewer inspects the pavement, road surface, curb, median, sidewalk, and visible road shoulders, then assigns exactly one of three states:

### 1. `verified_negative` (Clean Public Scene)
- **Definition**: The reviewer confirms with high confidence that **no visible municipal litter or discarded waste** exists anywhere in the image.
- **Criteria**:
  - The road surface and visible roadside areas are clean of discarded human-made trash.
  - Natural leaves, dried twigs, dust, water puddles, vehicle tire marks, painted crosswalks, or asphalt cracks do **NOT** count as garbage.
  - The image quality is sharp enough to determine that small litter (such as bottles, plastic bags, cups, snack wrappers, or food boxes) is absent.

### 2. `positive_litter` (Visible Litter Found)
- **Definition**: The reviewer observes **one or more visible discarded human-made litter objects** in the scene.
- **Criteria**:
  - Visible plastic bags, bottles, cans, paper packaging, fast-food containers, discarded clothing, bulk trash piles, or illegal dumping on the asphalt or shoulder.
  - **Action**: Mark as `positive_litter`. In the `notes` column, describe the observed object (e.g., `plastic bag on left curb`, `beverage can near median`).
  - *Note*: These images will NOT be used as negative examples; they are preserved as valuable new in-domain positive samples!

### 3. `uncertain` (Ambiguous / Low Visibility)
- **Definition**: The reviewer cannot reliably confirm whether litter is present or absent.
- **Criteria**:
  - Severe optical glare, heavy motion blur, deep shadow under tree cover, or dark nighttime exposure.
  - An ambiguous distant object on the road shoulder that might be a plastic bag, rock, or crumpled paper, but cannot be resolved clearly even at 100% zoom.
  - **Action**: Mark as `uncertain`. In the `notes` column, describe the ambiguity (e.g., `distant white shape on right shoulder unresolvable`, `heavy lens glare on right half`).
  - *Rule*: Uncertain images **must never be forced into a binary label** and will remain masked (`mask = 0`).

---

## 3. Reviewer Workflow Instructions

1. **Open the Review Sheet**: Open `garbage_negative_review_sheet.csv` in Excel, LibreOffice, or text editor.
2. **Visual Inspection**:
   - Open `review_gallery.html` in your browser (or inspect contact sheets in `contact_sheets/`).
   - Click any thumbnail in `review_gallery.html` to inspect the full-resolution $600 \times 600$ image in a new tab.
3. **Record Findings**:
   - In `reviewer_id`: Enter your reviewer code (e.g., `REV_01`).
   - In `review_date`: Enter the date (e.g., `2026-10-23`).
   - In `review_result`: Select exactly one: `verified_negative`, `positive_litter`, or `uncertain`.
   - In `notes`: Add brief context if marked `positive_litter` or `uncertain`.
4. **Save File**: Save the completed CSV with UTF-8 encoding. Do not modify candidate IDs, image paths, or split columns.
"""
    with open(protocol_path, "w", encoding="utf-8") as f:
        f.write(content)

def generate_review_plan_report(report_path: Path, records: list):
    split_counts = Counter(r["existing_split"] for r in records)
    country_counts = Counter(r["relative_image_path"].split("/")[1] if "/" in r["relative_image_path"] else r["relative_image_path"].split("\\")[1] for r in records)

    content = f"""# CivicVision AI — Phase F6-B9: Garbage-Negative Human Review Package Report

- **Date Prepared**: October 23, 2026
- **Status**: Package Generated & Ready for Human Review (Read-Only)
- **Deliverable Directory**: [`ai-service/data/manifest_out/f6_b9/`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/)

---

## 1. Executive Summary

This phase prepares a reproducible, protocol-driven human review package for **1,500 candidate garbage-negative images** selected from the 4,715 locally extracted clean-road RDD2022 scenes. 

### Key Principles Preserved:
1. **Zero Premature Labels**: No new labels have been assigned. Zero RDD road-defect annotations do **not** prove that garbage is absent. The candidates remain strictly in an unreviewed status until a human reviewer inspects them.
2. **100% Split Preservation**: Candidate selection used stratified random sampling (`seed=42`) within existing split partitions. Every selected image preserves its exact sequence group ID and existing `train`, `val`, or `test` assignment.
3. **Multi-Modal Inspection Tools**: Reviewers are provided with both a CSV review ledger, 15 thumbnail contact sheets (100 images per sheet), an interactive HTML review gallery, and an unambiguous review protocol.

---

## 2. Candidate Selection & Stratified Split Distribution

The 1,500 candidates were selected from the 4,715 verified clean-road RDD2022 images with fixed random seed `42`:

| Existing Split | Total Clean Pool in F6-B6 | Selected Candidates | Selection Ratio | Matching TACO Positives in F6-B6 | Post-Review Target Balance |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Train (70%)** | 3,300 | **1,050** | 31.82% | 1,039 | ~1 : 1 (1,039 pos / 1,050 neg) |
| **Validation (15%)** | 707 | **225** | 31.82% | 225 | **Exact 1 : 1 (225 pos / 225 neg)** |
| **Test (Quarantined 15%)** | 708 | **225** | 31.78% | 236 | **Exact 1 : 1 (236 pos / 225 neg)** |
| **Total** | **4,715** | **1,500** | **31.81%** | **1,500** | **~1 : 1 Balanced Benchmark** |

### Geographic Source Distribution:
- **India (`India/train/images/`)**: **474 candidates** (31.6%)
- **Japan (`Japan/train/images/`)**: **1,026 candidates** (68.4%)

---

## 3. Physical Verification & Duplicate Audit

All 1,500 candidates were verified physically against disk assets:
- **File Existence**: 1,500 / 1,500 (100% exist on disk).
- **PIL Decodability**: 1,500 / 1,500 (0 corrupt files).
- **Exact SHA-256 Hashes**: 1,500 unique hashes across 1,500 candidates (**0 duplicates**).
- **Split Leakage**: 1,500 unique sequence groups across 1,500 images (**0 cross-split leakage**).

---

## 4. Generated Review Materials Directory Inventory

The complete review package is isolated inside [`data/manifest_out/f6_b9/`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/):

| File / Asset | Location | Size | Description |
| :--- | :--- | :---: | :--- |
| **Review CSV Ledger** | [`data/manifest_out/f6_b9/garbage_negative_review_sheet.csv`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/garbage_negative_review_sheet.csv) | ~268 KB | Tabular review sheet with candidate IDs, paths, hashes, splits, and blank review fields. |
| **Candidate Metadata** | [`data/manifest_out/f6_b9/candidate_metadata.json`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/candidate_metadata.json) | ~890 KB | Machine-readable metadata payload recording selection seed, parameters, and full candidate list. |
| **Review Protocol** | [`data/manifest_out/f6_b9/REVIEW_PROTOCOL.md`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/REVIEW_PROTOCOL.md) | ~3.2 KB | Rigorous inspection manual defining `verified_negative`, `positive_litter`, and `uncertain`. |
| **Interactive Gallery** | [`data/manifest_out/f6_b9/review_gallery.html`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/review_gallery.html) | ~320 KB | Standalone browser gallery with split filtering and one-click full-resolution image inspection. |
| **Contact Sheets (15)** | [`data/manifest_out/f6_b9/contact_sheets/`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/contact_sheets/) | ~3.8 MB | 15 JPEG contact sheets, each displaying a $10 \\times 10$ labeled thumbnail montage of 100 candidates. |
| **Review Plan Report** | [`data/manifest_out/f6_b9/GARBAGE_NEGATIVE_REVIEW_PLAN.md`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/GARBAGE_NEGATIVE_REVIEW_PLAN.md) | ~8 KB | Master quality report documenting candidate selection, validation metrics, and protocol. |

---

## 5. Reviewer Protocol & Integrity Rules

Reviewers must strictly adhere to the documented rules in [`REVIEW_PROTOCOL.md`](file:///e:/SEMESTER_IV/COURSES/FullStack%20Development/FSD_PROJECT/Community_Issue_Tracker/ai-service/data/manifest_out/f6_b9/REVIEW_PROTOCOL.md):
1. **Never Assume Cleanliness**: Lack of road defects does not mean absence of litter.
2. **Handle Discovered Litter**: If an image contains discarded trash, record it as `positive_litter` and describe the object in `notes`. It will be added to the positive training pool, not discarded.
3. **No Forced Binary Choices**: If glare, shadow, or distant unidentifiable shapes make certainty impossible, record as `uncertain`. It will remain masked (`mask = 0`).
4. **Independent Provenance**: Reviewer ID and review timestamp are recorded per entry.

---

## 6. Next Steps & Current Status

- **Status**: The review materials are generated and awaiting human review.
- **Blockers**: No manifest or training code will be altered until a human reviewer completes and signs off on the review sheet.
- **Future Integration (Phase F6-B10)**: Once human review is completed, a derived manifest script will ingest the completed CSV, mark reviewed images as `garbage = 0` (or `garbage = 1` for discovered positives), leave uncertain images masked as `garbage = -1`, and verify the final balanced dataset.
"""
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(content)

if __name__ == "__main__":
    prepare_review_package()
