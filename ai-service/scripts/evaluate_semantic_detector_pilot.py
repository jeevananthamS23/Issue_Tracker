"""
CivicVision AI — Phase F6-B11: Semantic Litter Detector Evaluation
Evaluates YOLO-World v2 Small against the F6-B10 heuristic baseline on 50 pilot candidates.
"""

import os
import sys
import time
import json
import argparse
import datetime
import torch
from ultralytics import YOLOWorld
import cv2
import numpy as np
import pandas as pd

MODEL_NAME = "YOLO-World-v2-Small"
MODEL_VERSION = "yolov8s-worldv2.pt"
MODEL_WEIGHTS_PATH = "weights/yolov8s-worldv2.pt"
SEMANTIC_PROMPTS = ["litter", "rubbish", "plastic bag", "bottle", "can", "paper waste"]
CONF_THRESHOLD = 0.15  # Low threshold to capture weak candidates for comparison

def load_semantic_model(weights_path: str = MODEL_WEIGHTS_PATH):
    print(f"Loading {MODEL_NAME} from {weights_path} on CPU...")
    model = YOLOWorld(weights_path)
    model.set_classes(SEMANTIC_PROMPTS)
    print(f"Configured open-vocabulary classes: {model.names}")
    return model

def run_semantic_inference_on_pilot(
    input_sheet_path: str = "data/manifest_out/f6_b9/garbage_negative_review_sheet.csv",
    heuristic_csv_path: str = "data/manifest_out/f6_b10/pilot_screening_results.csv",
    output_dir: str = "data/manifest_out/f6_b11",
    limit: int = 50,
    conf_thresh: float = 0.15
):
    os.makedirs(output_dir, exist_ok=True)
    t0_total = time.time()
    
    # 1. Load candidate sheet and heuristic baseline
    df_sheet = pd.read_csv(input_sheet_path).head(limit)
    df_heur = pd.read_csv(heuristic_csv_path).head(limit)
    heur_map = {row["candidate_id"]: row for _, row in df_heur.iterrows()}
    
    # 2. Load model
    model = load_semantic_model()
    
    results = []
    print(f"Running semantic litter evaluation on {len(df_sheet)} candidates...")
    
    for idx, row in df_sheet.iterrows():
        cid = row["candidate_id"]
        img_path = row["absolute_image_path"]
        t_start = time.perf_counter()
        screening_ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
        
        heur_row = heur_map.get(cid, {})
        heur_class = heur_row.get("suggested_classification", "unknown")
        heur_conf = heur_row.get("confidence", 0.0)
        heur_reason = heur_row.get("decision_reason", "")
        
        if not os.path.exists(img_path):
            results.append({
                "candidate_id": cid,
                "sample_id": row["sample_id"],
                "group_id": row["group_id"],
                "existing_split": row["existing_split"],
                "relative_image_path": row["relative_image_path"],
                "absolute_image_path": img_path,
                "file_hash": row["file_hash"],
                "width": row["width"],
                "height": row["height"],
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "screening_timestamp": screening_ts,
                "suggested_classification": "uncertain",
                "confidence": 0.0,
                "decision_reason": "file_not_found",
                "detections_count": 0,
                "detections_detail": "[]",
                "top_detection_class": "none",
                "top_detection_conf": 0.0,
                "latency_ms": round((time.perf_counter() - t_start) * 1000, 2),
                "status": "error_file_missing",
                "heuristic_classification": heur_class,
                "heuristic_confidence": heur_conf,
                "heuristic_reason": heur_reason,
                "agreement_with_heuristic": False
            })
            continue
            
        try:
            # Run inference on CPU
            pred_results = model.predict(source=img_path, conf=conf_thresh, device="cpu", verbose=False)
            pred = pred_results[0]
            
            latency_ms = round((time.perf_counter() - t_start) * 1000, 2)
            
            boxes = pred.boxes
            detections = []
            
            if boxes is not None and len(boxes) > 0:
                for box in boxes:
                    xyxy = box.xyxy[0].tolist()
                    c_id = int(box.cls[0].item())
                    c_name = model.names.get(c_id, f"class_{c_id}")
                    score = float(box.conf[0].item())
                    
                    detections.append({
                        "class_id": c_id,
                        "class_name": c_name,
                        "confidence": round(score, 3),
                        "bbox_xyxy": [round(coord, 1) for coord in xyxy]
                    })
                    
            detections.sort(key=lambda d: d["confidence"], reverse=True)
            top_det = detections[0] if detections else None
            top_class = top_det["class_name"] if top_det else "none"
            top_conf = top_det["confidence"] if top_det else 0.0
            
            # Classification rule for Semantic Detector:
            # If high-confidence litter detected (conf >= 0.25): likely_positive_litter
            # If weak detection (0.15 <= conf < 0.25): uncertain
            # If 0 detections at threshold: likely_garbage_negative
            if top_conf >= 0.25:
                semantic_class = "likely_positive_litter"
                class_conf = top_conf
                reason = f"Detected {len(detections)} litter object(s); top: {top_class} ({top_conf:.2f})"
            elif top_conf >= 0.15:
                semantic_class = "uncertain"
                class_conf = top_conf
                reason = f"Low-confidence detection: {top_class} ({top_conf:.2f})"
            else:
                semantic_class = "likely_garbage_negative"
                class_conf = 0.85
                reason = f"Zero litter detections above conf {conf_thresh}"
                
            agreement = (semantic_class == heur_class)
            
            results.append({
                "candidate_id": cid,
                "sample_id": row["sample_id"],
                "group_id": row["group_id"],
                "existing_split": row["existing_split"],
                "relative_image_path": row["relative_image_path"],
                "absolute_image_path": img_path,
                "file_hash": row["file_hash"],
                "width": row["width"],
                "height": row["height"],
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "screening_timestamp": screening_ts,
                "suggested_classification": semantic_class,
                "confidence": round(class_conf, 3),
                "decision_reason": reason,
                "detections_count": len(detections),
                "detections_detail": json.dumps(detections),
                "top_detection_class": top_class,
                "top_detection_conf": round(top_conf, 3),
                "latency_ms": latency_ms,
                "status": "success",
                "heuristic_classification": heur_class,
                "heuristic_confidence": heur_conf,
                "heuristic_reason": heur_reason,
                "agreement_with_heuristic": agreement
            })
            
            if (idx + 1) % 10 == 0 or idx == len(df_sheet) - 1:
                print(f"  Processed {idx + 1}/{len(df_sheet)} images... (Last: {cid} -> {semantic_class}, {latency_ms:.1f}ms)")
                
        except Exception as e:
            results.append({
                "candidate_id": cid,
                "sample_id": row["sample_id"],
                "group_id": row["group_id"],
                "existing_split": row["existing_split"],
                "relative_image_path": row["relative_image_path"],
                "absolute_image_path": img_path,
                "file_hash": row["file_hash"],
                "width": row["width"],
                "height": row["height"],
                "model_name": MODEL_NAME,
                "model_version": MODEL_VERSION,
                "screening_timestamp": screening_ts,
                "suggested_classification": "uncertain",
                "confidence": 0.0,
                "decision_reason": f"inference_exception: {str(e)}",
                "detections_count": 0,
                "detections_detail": "[]",
                "top_detection_class": "none",
                "top_detection_conf": 0.0,
                "latency_ms": round((time.perf_counter() - t_start) * 1000, 2),
                "status": f"error: {str(e)}",
                "heuristic_classification": heur_class,
                "heuristic_confidence": heur_conf,
                "heuristic_reason": heur_reason,
                "agreement_with_heuristic": False
            })

    total_time = time.time() - t0_total
    results_df = pd.DataFrame(results)
    
    # Save CSV
    csv_out = os.path.join(output_dir, "semantic_screening_results.csv")
    results_df.to_csv(csv_out, index=False)
    print(f"Saved semantic screening results to: {csv_out}")
    
    # Agreement analysis
    agreement_count = int(results_df["agreement_with_heuristic"].sum())
    agreement_rate = agreement_count / len(results_df)
    
    # Cross-tabulation
    cross_tab = pd.crosstab(
        results_df["heuristic_classification"],
        results_df["suggested_classification"],
        rownames=["Heuristic (F6-B10)"],
        colnames=["Semantic (F6-B11)"]
    ).to_dict()
    
    class_counts = results_df["suggested_classification"].value_counts().to_dict()
    avg_latency = float(results_df["latency_ms"].mean())
    
    metadata = {
        "phase": "F6-B11",
        "description": "Semantic Litter Detector Evaluation (YOLO-World v2 Small vs F6-B10 Heuristic)",
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "model_weights_path": MODEL_WEIGHTS_PATH,
        "device": "cpu",
        "semantic_prompts": SEMANTIC_PROMPTS,
        "conf_threshold": conf_thresh,
        "total_images_processed": len(results_df),
        "total_runtime_seconds": round(total_time, 2),
        "avg_latency_ms_per_image": round(avg_latency, 2),
        "classification_counts": class_counts,
        "agreement_count": agreement_count,
        "agreement_rate": round(agreement_rate, 4),
        "cross_tabulation": cross_tab,
        "output_csv": csv_out
    }
    
    meta_out = os.path.join(output_dir, "semantic_screening_metadata.json")
    with open(meta_out, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    print(f"Saved metadata to: {meta_out}")
    
    # Generate Review Gallery
    gallery_out = os.path.join(output_dir, "semantic_review_gallery.html")
    generate_semantic_html_gallery(results_df, metadata, gallery_out)
    print(f"Saved interactive semantic review gallery to: {gallery_out}")
    
    return metadata, results_df

def generate_semantic_html_gallery(df: pd.DataFrame, meta: dict, output_path: str):
    counts = meta["classification_counts"]
    n_neg = counts.get("likely_garbage_negative", 0)
    n_pos = counts.get("likely_positive_litter", 0)
    n_unc = counts.get("uncertain", 0)
    total = len(df)
    agr_count = meta["agreement_count"]
    agr_rate = meta["agreement_rate"] * 100
    
    cards_html = []
    for idx, row in df.iterrows():
        cid = row["candidate_id"]
        gid = row["group_id"]
        split = row["existing_split"]
        sem_cls = row["suggested_classification"]
        sem_conf = row["confidence"]
        sem_reason = row["decision_reason"]
        heur_cls = row["heuristic_classification"]
        heur_conf = row["heuristic_confidence"]
        heur_reason = row["heuristic_reason"]
        agreed = row["agreement_with_heuristic"]
        lat = row["latency_ms"]
        det_count = row["detections_count"]
        top_cls = row["top_detection_class"]
        top_c = row["top_detection_conf"]
        
        # Image URL relative to f6_b11
        rel_img = "../../raw/" + row["relative_image_path"].replace("\\", "/")
        
        # Parse detections
        dets = json.loads(row["detections_detail"])
        det_tags = "".join([f'<span class="det-tag">{d["class_name"]} ({int(d["confidence"]*100)}%)</span>' for d in dets[:3]])
        if len(dets) > 3:
            det_tags += f'<span class="det-tag">+{len(dets)-3} more</span>'
        if not det_tags:
            det_tags = '<span class="det-none">No detections</span>'
            
        # Semantic badge
        if sem_cls == "likely_garbage_negative":
            sem_badge_cls = "badge-neg"
            card_border = "#22c55e"
        elif sem_cls == "likely_positive_litter":
            sem_badge_cls = "badge-pos"
            card_border = "#ef4444"
        else:
            sem_badge_cls = "badge-unc"
            card_border = "#f59e0b"
            
        agr_badge = '<span class="agr-badge agr-yes">AGREED</span>' if agreed else '<span class="agr-badge agr-no">DIVERGENT</span>'
        
        card = f"""
        <div class="card" data-class="{sem_cls}" data-agreed="{str(agreed).lower()}" data-split="{split}" style="border-top: 4px solid {card_border};">
          <div class="img-wrapper">
            <img src="{rel_img}" alt="{cid}" loading="lazy" onclick="window.open(this.src)">
            <span class="badge {sem_badge_cls}">{sem_cls.replace('_', ' ')}</span>
            {agr_badge}
          </div>
          <div class="card-body">
            <div class="card-header-row">
              <span class="card-id">{cid}</span>
              <span class="split-pill split-{split}">{split}</span>
            </div>
            
            <div class="meta-row">
              <span>Group: {gid}</span>
              <span>{lat:.1f}ms</span>
            </div>
            
            <!-- Comparison Box -->
            <div class="comparison-box">
              <div class="comp-col">
                <span class="comp-title">YOLO-World v2:</span>
                <span class="comp-val {sem_badge_cls}-text"><strong>{sem_cls}</strong> ({int(sem_conf*100)}%)</span>
                <span class="comp-sub">{sem_reason}</span>
              </div>
              <div class="comp-divider"></div>
              <div class="comp-col">
                <span class="comp-title">F6-B10 Heuristic:</span>
                <span class="comp-val"><strong>{heur_cls}</strong> ({int(heur_conf*100)}%)</span>
                <span class="comp-sub">{heur_reason}</span>
              </div>
            </div>
            
            <div class="detections-box">
              <span class="det-label">Semantic Detections ({det_count}):</span>
              <div class="det-tags-row">
                {det_tags}
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
<title>CivicVision AI — F6-B11 Semantic Litter Detector Evaluation</title>
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
  p.subtitle {{ color: var(--text-secondary); font-size: 14px; max-width: 950px; }}
  
  /* KPI Cards */
  .kpi-bar {{
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
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
  .kpi-title {{ font-size: 11px; color: var(--text-secondary); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }}
  .kpi-val {{ font-size: 26px; font-weight: 700; margin-top: 4px; }}
  .kpi-neg {{ color: var(--color-neg); }}
  .kpi-pos {{ color: var(--color-pos); }}
  .kpi-unc {{ color: var(--color-unc); }}
  .kpi-tot {{ color: var(--accent-blue); }}
  .kpi-agr {{ color: #a855f7; }}
  
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
    padding: 6px 12px;
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
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
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
  .badge-neg {{ background: #166534; color: #bbf7d0; border: 1px solid #22c55e; }}
  .badge-pos {{ background: #991b1b; color: #fecaca; border: 1px solid #ef4444; }}
  .badge-unc {{ background: #854d0e; color: #fef08a; border: 1px solid #f59e0b; }}
  .badge-neg-text {{ color: var(--color-neg); }}
  .badge-pos-text {{ color: var(--color-pos); }}
  .badge-unc-text {{ color: var(--color-unc); }}
  
  .agr-badge {{
    position: absolute;
    top: 10px;
    left: 10px;
    font-size: 10px;
    font-weight: 800;
    padding: 3px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }}
  .agr-yes {{ background: #4c1d95; color: #ddd6fe; border: 1px solid #8b5cf6; }}
  .agr-no {{ background: #374151; color: #f3f4f6; border: 1px solid #6b7280; }}
  
  .card-body {{ padding: 14px; display: flex; flex-direction: column; gap: 10px; flex-grow: 1; }}
  .card-header-row {{ display: flex; justify-content: space-between; align-items: center; }}
  .card-id {{ font-size: 14px; font-weight: 700; color: #fff; }}
  .split-pill {{ font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 600; text-transform: uppercase; }}
  .split-train {{ background: #1e3a8a; color: #93c5fd; }}
  .split-val {{ background: #713f12; color: #fde047; }}
  .split-test {{ background: #581c87; color: #f0abfc; }}
  
  .meta-row {{ display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }}
  
  /* Comparison Box */
  .comparison-box {{
    background: #0f172a;
    border: 1px solid var(--card-border);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 11px;
  }}
  .comp-col {{ display: flex; flex-direction: column; gap: 2px; }}
  .comp-title {{ font-size: 10px; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; }}
  .comp-val {{ font-size: 12px; }}
  .comp-sub {{ font-size: 10px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .comp-divider {{ height: 1px; background: #334155; margin: 2px 0; }}
  
  .detections-box {{ display: flex; flex-direction: column; gap: 4px; }}
  .det-label {{ font-size: 11px; color: var(--text-secondary); font-weight: 600; }}
  .det-tags-row {{ display: flex; flex-wrap: wrap; gap: 4px; }}
  .det-tag {{ background: #334155; color: #f8fafc; font-size: 10px; padding: 2px 6px; border-radius: 4px; border: 1px solid #475569; }}
  .det-none {{ font-size: 11px; color: #64748b; font-style: italic; }}
</style>
<script>
  let currentClass = 'all';
  let currentAgr = 'all';
  let currentSplit = 'all';
  
  function applyFilters() {{
    let visible = 0;
    const cards = document.querySelectorAll('.card');
    cards.forEach(card => {{
      const matchClass = (currentClass === 'all' || card.dataset.class === currentClass);
      const matchAgr = (currentAgr === 'all' || card.dataset.agreed === currentAgr);
      const matchSplit = (currentSplit === 'all' || card.dataset.split === currentSplit);
      if (matchClass && matchAgr && matchSplit) {{
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
  
  function filterAgr(agr) {{
    currentAgr = agr;
    document.querySelectorAll('.btn-agr').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-agr-' + agr).classList.add('active');
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
    <h1>CivicVision AI — F6-B11 Semantic Litter Detector Evaluation Gallery</h1>
    <p class="subtitle">Controlled evaluation of <strong>YOLO-World v2 Small</strong> open-vocabulary detector vs <strong>F6-B10 OpenCV Heuristic</strong> across the 50 pilot candidate clean-road images. <em>Evaluation only — no ground-truth claims made without manual verification.</em></p>
  </header>
  
  <div class="kpi-bar">
    <div class="kpi-card">
      <div class="kpi-title">Images Screened</div>
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
      <div class="kpi-title">Uncertain / Weak</div>
      <div class="kpi-val kpi-unc">{n_unc} ({n_unc/total*100:.1f}%)</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Agreement Rate</div>
      <div class="kpi-val kpi-agr">{agr_rate:.1f}% ({agr_count}/{total})</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-title">Avg CPU Latency</div>
      <div class="kpi-val" style="color: #cbd5e1;">{meta['avg_latency_ms_per_image']:.1f} ms</div>
    </div>
  </div>
  
  <div class="controls-panel">
    <div class="filter-group">
      <span class="filter-label">Semantic Prediction:</span>
      <button id="btn-class-all" class="btn-filter btn-class active" onclick="filterClass('all')">All ({total})</button>
      <button id="btn-class-likely_garbage_negative" class="btn-filter btn-class" onclick="filterClass('likely_garbage_negative')">Negative ({n_neg})</button>
      <button id="btn-class-likely_positive_litter" class="btn-filter btn-class" onclick="filterClass('likely_positive_litter')">Positive ({n_pos})</button>
      <button id="btn-class-uncertain" class="btn-filter btn-class" onclick="filterClass('uncertain')">Uncertain ({n_unc})</button>
    </div>
    
    <div class="filter-group">
      <span class="filter-label">Baseline Agreement:</span>
      <button id="btn-agr-all" class="btn-filter btn-agr active" onclick="filterAgr('all')">All</button>
      <button id="btn-agr-true" class="btn-filter btn-agr" onclick="filterAgr('true')">Agreed ({agr_count})</button>
      <button id="btn-agr-false" class="btn-filter btn-agr" onclick="filterAgr('false')">Divergent ({total - agr_count})</button>
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
    parser = argparse.ArgumentParser(description="Evaluate YOLO-World semantic detector on pilot candidates")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--conf", type=float, default=0.15)
    args = parser.parse_args()
    
    run_semantic_inference_on_pilot(limit=args.limit, conf_thresh=args.conf)
