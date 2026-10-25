"""
CivicVision AI — Phase F6-B10: Automated AI Visual Review for Garbage-Negative Candidates
Screening Pipeline & Pilot Validation Script

This script performs reproducible, automated visual inspection of candidate clean-road images
from Phase F6-B9 to screen for garbage-negative candidates, visible litter/debris, and ambiguous scenes.
Adheres strictly to zero-split-leakage and preservation of existing manifests.
"""

import os
import sys
import time
import json
import argparse
import datetime
import cv2
import numpy as np
import pandas as pd

MODEL_NAME = "CivicVision-Visual-Inspector"
MODEL_VERSION = "1.0.0-local-heuristic-ensemble"

def inspect_image_scene(image_path: str) -> dict:
    """
    Safely inspect a single candidate image for visible litter, garbage, rubbish, plastic/paper waste.
    Preserves original file. Returns standardized screening dictionary.
    """
    start_t = time.perf_counter()
    screening_ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    
    if not os.path.exists(image_path):
        return {
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "screening_timestamp": screening_ts,
            "suggested_classification": "uncertain",
            "confidence": 0.0,
            "decision_reason": "file_not_found",
            "metrics": {},
            "latency_ms": round((time.perf_counter() - start_t) * 1000, 2),
            "status": "error_file_missing"
        }
        
    try:
        img = cv2.imread(image_path)
    except Exception as e:
        return {
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "screening_timestamp": screening_ts,
            "suggested_classification": "uncertain",
            "confidence": 0.0,
            "decision_reason": f"image_read_exception: {str(e)}",
            "metrics": {},
            "latency_ms": round((time.perf_counter() - start_t) * 1000, 2),
            "status": "error_corrupted"
        }
        
    if img is None:
        return {
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "screening_timestamp": screening_ts,
            "suggested_classification": "uncertain",
            "confidence": 0.0,
            "decision_reason": "cv2_imread_returned_none",
            "metrics": {},
            "latency_ms": round((time.perf_counter() - start_t) * 1000, 2),
            "status": "error_unreadable"
        }
        
    h, w, c = img.shape
    
    # Check extreme illumination / camera failure
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_val = float(np.mean(gray))
    std_val = float(np.std(gray))
    if mean_val < 25 or mean_val > 235 or std_val < 15:
        return {
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "screening_timestamp": screening_ts,
            "suggested_classification": "uncertain",
            "confidence": 0.30,
            "decision_reason": f"extreme_illumination (mean={mean_val:.1f}, std={std_val:.1f})",
            "metrics": {"mean_val": round(mean_val, 1), "std_val": round(std_val, 1)},
            "latency_ms": round((time.perf_counter() - start_t) * 1000, 2),
            "status": "warning_extreme_exposure"
        }
        
    # Region of Interest (ROI): Ground-Plane Drivable Surface
    # Lower 65% of image, excluding lateral 8% margins where roadside clutter/curbs reside
    roi_top = int(0.35 * h)
    roi_left = int(0.08 * w)
    roi_right = int(0.92 * w)
    
    roi = img[roi_top:h, roi_left:roi_right]
    roi_h, roi_w = roi.shape[:2]
    roi_area = roi_h * roi_w
    
    # Color spaces
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(roi, cv2.COLOR_BGR2LAB)
    roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    l_chan = lab[:, :, 0]
    a_chan = lab[:, :, 1]
    b_chan = lab[:, :, 2]
    
    # 1. Road surface baseline estimation
    # Clean asphalt has low saturation (< 50) and moderate value (45-205)
    road_mask = (sat < 50) & (val > 45) & (val < 205)
    road_pixel_count = int(np.sum(road_mask))
    road_coverage = road_pixel_count / roi_area
    
    # 2. Chromatic Anomaly Detection (synthetic litter: plastic bags, snack wrappers, beverage cans)
    # High saturation (> 90), or significant chroma distance from neutral gray (128, 128 in LAB)
    chroma_dist = np.sqrt((a_chan.astype(float) - 128.0)**2 + (b_chan.astype(float) - 128.0)**2)
    chroma_anomaly = (sat > 90) & (val > 60) & (chroma_dist > 30)
    
    # 3. High-Reflectance Albedo Anomaly (white paper, styrofoam, fast food packaging)
    bright_anomaly = (l_chan > 225) & (sat < 60)
    
    # Filter continuous lane markings: elongated vertical or angled lines
    kernel_vert = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 27))
    lane_marks = cv2.morphologyEx(bright_anomaly.astype(np.uint8), cv2.MORPH_OPEN, kernel_vert)
    bright_isolated = bright_anomaly.astype(np.uint8) & (~lane_marks.astype(bool))
    
    # Combined raw anomaly
    raw_anomaly = (chroma_anomaly | bright_isolated.astype(bool)).astype(np.uint8) * 255
    
    # Remove single-pixel noise
    kernel_clean = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned_anomaly = cv2.morphologyEx(raw_anomaly, cv2.MORPH_OPEN, kernel_clean)
    
    # Morphological connected components / contours
    contours, _ = cv2.findContours(cleaned_anomaly, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    debris_candidates = []
    total_anomaly_px = 0
    
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if 50 <= area <= 6000:
            x, y, bw, bh = cv2.boundingRect(cnt)
            aspect = float(bw) / bh if bh > 0 else 1.0
            # Discard markings or dividers with extreme aspect ratio
            if 0.3 <= aspect <= 3.5:
                # Sample local contrast against background ring
                blob_mask = np.zeros((bh, bw), dtype=np.uint8)
                cv2.drawContours(blob_mask, [cnt - [x, y]], -1, 255, -1)
                blob_patch = roi_gray[y:y+bh, x:x+bw]
                blob_mean = np.mean(blob_patch[blob_mask == 255]) if np.any(blob_mask == 255) else 0
                
                ring_mask = cv2.dilate(blob_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) - blob_mask
                surround_mean = np.mean(blob_patch[ring_mask == 255]) if np.any(ring_mask == 255) else blob_mean
                contrast_salience = abs(blob_mean - surround_mean) / 255.0
                
                if contrast_salience > 0.18:
                    debris_candidates.append({
                        "area": float(area),
                        "bbox": [int(x + roi_left), int(y + roi_top), int(bw), int(bh)],
                        "salience": round(float(contrast_salience), 3)
                    })
                    total_anomaly_px += area

    anomaly_ratio = total_anomaly_px / roi_area
    
    # 4. Illumination & Shadow Complexity Index (ISCI)
    deep_shadow_mask = (val < 35)
    glare_mask = (val > 245)
    shadow_glare_ratio = (np.sum(deep_shadow_mask) + np.sum(glare_mask)) / roi_area
    
    laplacian = cv2.Laplacian(roi_gray, cv2.CV_64F)
    lap_var = float(laplacian.var())
    
    # Sort debris candidates by salience
    debris_candidates.sort(key=lambda d: d["salience"], reverse=True)
    max_salience = debris_candidates[0]["salience"] if debris_candidates else 0.0
    
    # Decision Rules (Conservative)
    if shadow_glare_ratio > 0.20:
        classification = "uncertain"
        confidence = 0.45
        reason = f"high_shadow_glare_ambiguity (ratio={shadow_glare_ratio:.2f})"
    elif len(debris_candidates) >= 1 and (max_salience > 0.38 or (len(debris_candidates) >= 2 and max_salience > 0.28)):
        classification = "likely_positive_litter"
        confidence = round(min(0.90, 0.55 + max_salience * 0.7), 2)
        reason = f"candidate_litter_detected ({len(debris_candidates)} blobs, max_salience={max_salience:.2f})"
    elif len(debris_candidates) == 0 and road_coverage > 0.60 and shadow_glare_ratio < 0.12 and lap_var < 550:
        classification = "likely_garbage_negative"
        confidence = round(min(0.95, 0.75 + road_coverage * 0.2 - shadow_glare_ratio), 2)
        reason = f"clean_uniform_roadway (coverage={road_coverage:.2f})"
    else:
        classification = "uncertain"
        confidence = 0.50
        reason = f"moderate_visual_ambiguity (blobs={len(debris_candidates)}, cov={road_coverage:.2f})"
        
    latency_ms = round((time.perf_counter() - start_t) * 1000, 2)
    
    return {
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "screening_timestamp": screening_ts,
        "suggested_classification": classification,
        "confidence": confidence,
        "decision_reason": reason,
        "metrics": {
            "road_coverage": round(road_coverage, 4),
            "debris_blob_count": len(debris_candidates),
            "max_salience": max_salience,
            "anomaly_ratio": round(anomaly_ratio, 5),
            "shadow_glare_ratio": round(shadow_glare_ratio, 4),
            "laplacian_var": round(lap_var, 1),
            "top_candidate_blobs": debris_candidates[:3]
        },
        "latency_ms": latency_ms,
        "status": "success"
    }

def run_pilot_screening(input_csv: str, output_dir: str, limit: int = 50, batch_size: int = 10):
    """
    Runs pilot screening on the specified limit of images from input_csv.
    Generates pilot_screening_results.csv, metadata, and HTML gallery.
    """
    os.makedirs(output_dir, exist_ok=True)
    df = pd.read_csv(input_csv)
    
    pilot_df = df.head(limit).copy()
    print(f"Loaded {len(pilot_df)} candidate images for pilot screening (limit={limit}).")
    
    results = []
    t_start = time.time()
    
    for i in range(0, len(pilot_df), batch_size):
        batch = pilot_df.iloc[i:i+batch_size]
        print(f"Processing batch {i // batch_size + 1} / {(len(pilot_df) + batch_size - 1) // batch_size} (images {i+1} to {min(i+batch_size, len(pilot_df))})...")
        for idx, row in batch.iterrows():
            img_path = row["absolute_image_path"]
            res = inspect_image_scene(img_path)
            
            # Combine record
            record = {
                "candidate_id": row["candidate_id"],
                "sample_id": row["sample_id"],
                "group_id": row["group_id"],
                "existing_split": row["existing_split"],
                "relative_image_path": row["relative_image_path"],
                "absolute_image_path": row["absolute_image_path"],
                "file_hash": row["file_hash"],
                "width": row["width"],
                "height": row["height"],
                "model_name": res["model_name"],
                "model_version": res["model_version"],
                "screening_timestamp": res["screening_timestamp"],
                "suggested_classification": res["suggested_classification"],
                "confidence": res["confidence"],
                "decision_reason": res["decision_reason"],
                "debris_blob_count": res["metrics"].get("debris_blob_count", 0),
                "max_salience": res["metrics"].get("max_salience", 0.0),
                "road_coverage": res["metrics"].get("road_coverage", 0.0),
                "shadow_glare_ratio": res["metrics"].get("shadow_glare_ratio", 0.0),
                "laplacian_var": res["metrics"].get("laplacian_var", 0.0),
                "latency_ms": res["latency_ms"],
                "status": res["status"]
            }
            results.append(record)
            
    total_time = time.time() - t_start
    results_df = pd.DataFrame(results)
    
    # Save CSV
    csv_out = os.path.join(output_dir, "pilot_screening_results.csv")
    results_df.to_csv(csv_out, index=False)
    print(f"Saved pilot screening CSV to: {csv_out}")
    
    # Calculate summary statistics
    class_counts = results_df["suggested_classification"].value_counts().to_dict()
    split_counts = results_df["existing_split"].value_counts().to_dict()
    avg_latency = results_df["latency_ms"].mean()
    
    metadata = {
        "phase": "F6-B10",
        "description": "Automated AI Visual Review Pilot for Garbage-Negative Candidates",
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "total_images_processed": len(results_df),
        "total_runtime_seconds": round(total_time, 2),
        "avg_latency_ms_per_image": round(avg_latency, 2),
        "classification_counts": class_counts,
        "split_counts": split_counts,
        "input_csv": input_csv,
        "output_csv": csv_out
    }
    
    meta_out = os.path.join(output_dir, "pilot_screening_metadata.json")
    with open(meta_out, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    print(f"Saved metadata to: {meta_out}")
    
    # Generate HTML Gallery
    gallery_out = os.path.join(output_dir, "pilot_screening_gallery.html")
    generate_html_gallery(results_df, metadata, gallery_out)
    print(f"Saved interactive pilot screening gallery to: {gallery_out}")
    
    return metadata

def generate_html_gallery(df: pd.DataFrame, meta: dict, output_path: str):
    """
    Generates a responsive, dark-mode review gallery with AI suggestions and filters.
    """
    counts = meta["classification_counts"]
    n_neg = counts.get("likely_garbage_negative", 0)
    n_pos = counts.get("likely_positive_litter", 0)
    n_unc = counts.get("uncertain", 0)
    total = len(df)
    
    cards_html = []
    for idx, row in df.iterrows():
        cid = row["candidate_id"]
        gid = row["group_id"]
        split = row["existing_split"]
        sugg = row["suggested_classification"]
        conf = row["confidence"]
        reason = row["decision_reason"]
        blobs = row["debris_blob_count"]
        salience = row["max_salience"]
        cov = row["road_coverage"]
        shadow = row["shadow_glare_ratio"]
        lat = row["latency_ms"]
        
        # Image URL (relative to f6_b10 directory in manifest_out)
        # ../../raw/rdd2022/India/train/images/India_000001.jpg
        rel_img = "../../raw/" + row["relative_image_path"].replace("\\", "/")
        
        # Badge styling
        if sugg == "likely_garbage_negative":
            badge_class = "badge-negative"
            badge_label = "Likely Garbage Negative"
            card_border = "#22c55e"
        elif sugg == "likely_positive_litter":
            badge_class = "badge-positive"
            badge_label = "Likely Positive Litter"
            card_border = "#ef4444"
        else:
            badge_class = "badge-uncertain"
            badge_label = "Uncertain"
            card_border = "#f59e0b"
            
        card = f"""
        <div class="card" data-class="{sugg}" data-split="{split}" style="border-top: 4px solid {card_border};">
          <div class="img-wrapper">
            <img src="{rel_img}" alt="{cid}" loading="lazy" onclick="window.open(this.src)">
            <span class="badge {badge_class}">{badge_label}</span>
          </div>
          <div class="card-body">
            <div class="card-header-row">
              <span class="card-id">{cid}</span>
              <span class="split-pill split-{split}">{split}</span>
            </div>
            <div class="meta-row">
              <span class="group-id">Group: {gid}</span>
              <span class="latency">{lat:.1f}ms</span>
            </div>
            
            <div class="confidence-box">
              <div class="conf-label">
                <span>Confidence</span>
                <strong>{int(conf * 100)}%</strong>
              </div>
              <div class="progress-bar">
                <div class="progress-fill {badge_class}-fill" style="width: {int(conf * 100)}%;"></div>
              </div>
            </div>
            
            <div class="reason-box" title="{reason}">
              <span class="reason-text"><strong>Decision:</strong> {reason}</span>
            </div>
            
            <div class="metrics-grid">
              <div class="metric-item">
                <span class="metric-name">Blobs</span>
                <span class="metric-val">{blobs}</span>
              </div>
              <div class="metric-item">
                <span class="metric-name">Salience</span>
                <span class="metric-val">{salience:.2f}</span>
              </div>
              <div class="metric-item">
                <span class="metric-name">Road Cov</span>
                <span class="metric-val">{int(cov * 100)}%</span>
              </div>
              <div class="metric-item">
                <span class="metric-name">Shadow</span>
                <span class="metric-val">{int(shadow * 100)}%</span>
              </div>
            </div>
          </div>
        </div>
        """
        cards_html.append(card)
        
    cards_str = "\n".join(cards_html)
    
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CivicVision AI — F6-B10 Automated AI Visual Review Gallery (Pilot 50)</title>
<style>
  :root {{
    --bg-dark: #0f172a;
    --card-bg: #1e293b;
    --card-border: #334155;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --accent-blue: #38bdf8;
    --color-neg: #22c55e;
    --color-pos: #ef4444;
    --color-unc: #f59e0b;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg-dark);
    color: var(--text-primary);
    padding: 24px;
    line-height: 1.5;
  }}
  header {{
    margin-bottom: 24px;
    border-bottom: 1px solid var(--card-border);
    padding-bottom: 16px;
  }}
  h1 {{ font-size: 24px; color: var(--accent-blue); margin-bottom: 6px; }}
  p.subtitle {{ color: var(--text-secondary); font-size: 14px; max-width: 900px; }}
  
  /* KPI Cards */
  .kpi-bar {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }}
  .kpi-card {{
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }}
  .kpi-title {{ font-size: 12px; color: var(--text-secondary); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }}
  .kpi-val {{ font-size: 28px; font-weight: 700; margin-top: 4px; }}
  .kpi-neg {{ color: var(--color-neg); }}
  .kpi-pos {{ color: var(--color-pos); }}
  .kpi-unc {{ color: var(--color-unc); }}
  .kpi-tot {{ color: var(--accent-blue); }}
  
  /* Controls */
  .controls-panel {{
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: center;
    justify-content: space-between;
  }}
  .filter-group {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .filter-label {{ font-size: 13px; font-weight: 600; color: var(--text-secondary); }}
  .btn-filter {{
    background: #0f172a;
    color: var(--text-primary);
    border: 1px solid var(--card-border);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s ease;
  }}
  .btn-filter:hover {{ border-color: var(--accent-blue); }}
  .btn-filter.active {{ background: #0284c7; border-color: #38bdf8; color: #fff; }}
  .counter {{ font-size: 14px; color: var(--text-secondary); font-weight: 500; }}
  
  /* Grid */
  .gallery-grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 20px;
  }}
  .card {{
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }}
  .card:hover {{
    transform: translateY(-3px);
    box-shadow: 0 10px 20px rgba(0,0,0,0.4);
  }}
  .img-wrapper {{
    position: relative;
    width: 100%;
    height: 220px;
    background: #000;
  }}
  .img-wrapper img {{
    width: 100%;
    height: 100%;
    object-fit: cover;
    cursor: zoom-in;
  }}
  .badge {{
    position: absolute;
    top: 10px;
    right: 10px;
    font-size: 11px;
    font-weight: 700;
    padding: 4px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
  }}
  .badge-negative {{ background: #166534; color: #bbf7d0; border: 1px solid #22c55e; }}
  .badge-positive {{ background: #991b1b; color: #fecaca; border: 1px solid #ef4444; }}
  .badge-uncertain {{ background: #854d0e; color: #fef08a; border: 1px solid #f59e0b; }}
  
  .card-body {{ padding: 14px; display: flex; flex-direction: column; gap: 10px; flex-grow: 1; }}
  .card-header-row {{ display: flex; justify-content: space-between; align-items: center; }}
  .card-id {{ font-size: 14px; font-weight: 700; color: #fff; }}
  .split-pill {{ font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 600; text-transform: uppercase; }}
  .split-train {{ background: #1e3a8a; color: #93c5fd; }}
  .split-val {{ background: #713f12; color: #fde047; }}
  .split-test {{ background: #581c87; color: #f0abfc; }}
  
  .meta-row {{ display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }}
  
  .confidence-box {{ display: flex; flex-direction: column; gap: 4px; }}
  .conf-label {{ display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }}
  .progress-bar {{ width: 100%; height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; }}
  .progress-fill {{ height: 100%; }}
  .badge-negative-fill {{ background: var(--color-neg); }}
  .badge-positive-fill {{ background: var(--color-pos); }}
  .badge-uncertain-fill {{ background: var(--color-unc); }}
  
  .reason-box {{
    background: #0f172a;
    padding: 8px;
    border-radius: 4px;
    font-size: 11px;
    color: #cbd5e1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }}
  
  .metrics-grid {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    background: #0f172a;
    padding: 8px;
    border-radius: 6px;
    text-align: center;
  }}
  .metric-item {{ display: flex; flex-direction: column; }}
  .metric-name {{ font-size: 9px; color: var(--text-secondary); text-transform: uppercase; }}
  .metric-val {{ font-size: 12px; font-weight: 700; color: #f1f5f9; }}
</style>
<script>
  let currentClass = 'all';
  let currentSplit = 'all';
  
  function applyFilters() {{
    let visible = 0;
    const cards = document.querySelectorAll('.card');
    cards.forEach(card => {{
      const matchClass = (currentClass === 'all' || card.dataset.class === currentClass);
      const matchSplit = (currentSplit === 'all' || card.dataset.split === currentSplit);
      if (matchClass && matchSplit) {{
        card.style.display = 'flex';
        visible++;
      }} else {{
        card.style.display = 'none';
      }}
    }});
    document.getElementById('visible-count').innerText = visible;
  }}
  
  function filterClass(cls) {{
    currentClass = cls;
    document.querySelectorAll('.btn-class').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-class-' + cls).classList.add('active');
    applyFilters();
  }}
  
  function filterSplit(sp) {{
    currentSplit = sp;
    document.querySelectorAll('.btn-split').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-split-' + sp).classList.add('active');
    applyFilters();
  }}
</script>
</head>
<body>
  <header>
    <h1>CivicVision AI — F6-B10 Automated AI Visual Review Gallery</h1>
    <p class="subtitle">Automated visual screening pilot on 50 candidate clean-road images from RDD2022 (F6-B9 package). Multi-scale visual anomaly inspection evaluating road surface homogeneity, chromatic debris, and high-reflectance artifacts. <strong>Pilot screening only — human verification remains required.</strong></p>
  </header>
  
  <div class="kpi-bar">
    <div class="kpi-card">
      <div class="kpi-title">Images Processed</div>
      <div class="kpi-val kpi-tot">{total}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Likely Negative</div>
      <div class="kpi-val kpi-neg">{n_neg} ({n_neg/total*100:.1f}%)</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Likely Positive (Litter)</div>
      <div class="kpi-val kpi-pos">{n_pos} ({n_pos/total*100:.1f}%)</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Uncertain / Ambiguous</div>
      <div class="kpi-val kpi-unc">{n_unc} ({n_unc/total*100:.1f}%)</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Avg Latency</div>
      <div class="kpi-val" style="color: #cbd5e1;">{meta['avg_latency_ms_per_image']:.1f} ms</div>
    </div>
  </div>
  
  <div class="controls-panel">
    <div class="filter-group">
      <span class="filter-label">AI Classification:</span>
      <button id="btn-class-all" class="btn-filter btn-class active" onclick="filterClass('all')">All ({total})</button>
      <button id="btn-class-likely_garbage_negative" class="btn-filter btn-class" onclick="filterClass('likely_garbage_negative')">Likely Negative ({n_neg})</button>
      <button id="btn-class-likely_positive_litter" class="btn-filter btn-class" onclick="filterClass('likely_positive_litter')">Likely Positive ({n_pos})</button>
      <button id="btn-class-uncertain" class="btn-filter btn-class" onclick="filterClass('uncertain')">Uncertain ({n_unc})</button>
    </div>
    
    <div class="filter-group">
      <span class="filter-label">Split:</span>
      <button id="btn-split-all" class="btn-filter btn-split active" onclick="filterSplit('all')">All</button>
      <button id="btn-split-train" class="btn-filter btn-split" onclick="filterSplit('train')">Train</button>
      <button id="btn-split-val" class="btn-filter btn-split" onclick="filterSplit('val')">Val</button>
      <button id="btn-split-test" class="btn-filter btn-split" onclick="filterSplit('test')">Test</button>
    </div>
    
    <div class="counter">
      Showing: <strong id="visible-count" style="color: var(--accent-blue);">{total}</strong> / {total}
    </div>
  </div>
  
  <div class="gallery-grid">
    {cards_str}
  </div>
</body>
</html>
"""
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pilot visual screening for garbage-negative candidates")
    parser.add_argument("--input-csv", default="data/manifest_out/f6_b9/garbage_negative_review_sheet.csv")
    parser.add_argument("--output-dir", default="data/manifest_out/f6_b10")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=10)
    args = parser.parse_args()
    
    run_pilot_screening(args.input_csv, args.output_dir, args.limit, args.batch_size)
