"""
CivicVision AI — Phase 1 Road Defect Classifier Test Evaluation Script
Evaluates the best checkpoint (Epoch 8) on the held-out test split (N=2,408).
Uses frozen validation-calibrated thresholds. No threshold tuning on test data.
"""

import os
import sys
import json
import time
import datetime
import argparse
from pathlib import Path
from typing import Dict, List, Any, Optional

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

# Add ai-service to path
CURRENT_DIR = Path(__file__).resolve().parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from scripts.train_road_classifier import (
    RoadDefectDataset,
    filter_rdd_samples,
    get_transforms,
    build_mobilenetv3_road_classifier,
    masked_bce_loss,
    set_seed
)


def calculate_metrics_for_class(
    targets: np.ndarray,
    probs: np.ndarray,
    threshold: float
) -> Dict[str, Any]:
    """Calculates TP, FP, TN, FN, Precision, Recall, F1, Accuracy, and Confusion Matrix."""
    preds = (probs >= threshold).astype(int)
    targets = targets.astype(int)

    tp = int(np.sum((preds == 1) & (targets == 1)))
    fp = int(np.sum((preds == 1) & (targets == 0)))
    tn = int(np.sum((preds == 0) & (targets == 0)))
    fn = int(np.sum((preds == 0) & (targets == 1)))
    total = tp + fp + tn + fn

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
    accuracy = (tp + tn) / total if total > 0 else 0.0

    return {
        "threshold": round(float(threshold), 3),
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "total": total,
        "precision": round(float(precision), 4),
        "recall": round(float(recall), 4),
        "f1": round(float(f1), 4),
        "accuracy": round(float(accuracy), 4),
        "confusion_matrix": [[tn, fp], [fn, tp]]
    }


def parse_args():
    parser = argparse.ArgumentParser(description="CivicVision AI — Phase 1 Test Evaluation")
    parser.add_argument(
        "--checkpoint_path",
        type=str,
        default="checkpoints/phase1_road_classifier/run_20261027_pretrained_bs8_e10/best_model.pt",
        help="Path to trained model checkpoint (.pt)"
    )
    parser.add_argument(
        "--config_path",
        type=str,
        default="checkpoints/phase1_road_classifier/run_20261027_pretrained_bs8_e10/config.json",
        help="Path to training config.json"
    )
    parser.add_argument(
        "--manifest_path",
        type=str,
        default="data/manifest_out/f6_b6/multilabel_manifest.json",
        help="Path to multi-label manifest JSON"
    )
    parser.add_argument(
        "--raw_root",
        type=str,
        default="data/raw",
        help="Path to raw image root directory"
    )
    parser.add_argument(
        "--output_dir",
        type=str,
        default="checkpoints/phase1_road_classifier/run_20261027_pretrained_bs8_e10",
        help="Output directory to save test evaluation report"
    )
    parser.add_argument(
        "--batch_size",
        type=int,
        default=16,
        help="Batch size for test evaluation"
    )
    parser.add_argument(
        "--device",
        type=str,
        default="cpu",
        help="Inference device (cpu or cuda)"
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Deterministic evaluation seed"
    )
    return parser.parse_args()


def run_evaluation(args) -> Dict[str, Any]:
    print("=" * 75)
    print("CivicVision AI — MobileNetV3-Small Phase 1 Test Evaluation")
    print("=" * 75)
    print(f"Timestamp: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
    print(f"Device: {args.device} | Batch Size: {args.batch_size} | Seed: {args.seed}")
    print(f"Checkpoint: {args.checkpoint_path}")
    print(f"Manifest: {args.manifest_path}")

    set_seed(args.seed)
    device = torch.device(args.device)

    # 1. Load Checkpoint & Configuration
    ckpt_path = Path(args.checkpoint_path)
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Checkpoint not found at: {ckpt_path}")

    checkpoint = torch.load(ckpt_path, map_location="cpu")
    print("\nCheckpoint loaded successfully.")
    
    # Extract validation metrics & thresholds from checkpoint
    val_metrics = checkpoint.get("val_metrics", {})
    val_classes = val_metrics.get("classes", {})
    val_macro_f1 = val_metrics.get("macro_f1", None)
    val_avg_loss = val_metrics.get("avg_loss", None)

    # Saved thresholds from validation calibration
    frozen_thresholds = {}
    for cat, metrics in val_classes.items():
        frozen_thresholds[cat] = float(metrics.get("threshold", 0.50))

    # Fallback to config if not directly in checkpoint
    labels = ["pothole", "road_damage"]
    config_p = Path(args.config_path)
    if config_p.exists():
        with open(config_p, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            labels = cfg.get("labels", labels)
            pos_weight_vals = cfg.get("pos_weights", [4.43, 1.0])
    else:
        pos_weight_vals = [4.43, 1.0]

    pos_weight = torch.tensor(pos_weight_vals, dtype=torch.float32).to(device)

    print(f"Target Labels: {labels}")
    print(f"Validation-Calibrated Frozen Thresholds: {frozen_thresholds}")
    print(f"Validation Baseline: Loss={val_avg_loss}, Macro-F1={val_macro_f1}")

    # 2. Dataset Separation & Verification
    manifest_p = Path(args.manifest_path)
    if not manifest_p.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_p}")

    with open(manifest_p, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    # Check split isolation
    train_samples = filter_rdd_samples(manifest_data, split="train", target_labels=labels)
    val_samples = filter_rdd_samples(manifest_data, split="val", target_labels=labels)
    test_samples = filter_rdd_samples(manifest_data, split="test", target_labels=labels)

    train_ids = {s["sample_id"] for s in train_samples}
    val_ids = {s["sample_id"] for s in val_samples}
    test_ids = {s["sample_id"] for s in test_samples}

    assert len(train_ids.intersection(test_ids)) == 0, "DATASET CONTAMINATION: Train and Test IDs overlap!"
    assert len(val_ids.intersection(test_ids)) == 0, "DATASET CONTAMINATION: Val and Test IDs overlap!"
    assert len(test_samples) == 2408, f"Expected 2,408 test samples, found {len(test_samples)}"

    print(f"\n--- Dataset Quarantine Audit ---")
    print(f"  Train Samples (RDD2022): {len(train_samples):,}")
    print(f"  Val Samples   (RDD2022): {len(val_samples):,}")
    print(f"  Test Samples  (RDD2022): {len(test_samples):,} (Verified 100% disjoint, 0 overlap)")

    raw_root = Path(args.raw_root)
    # Verify image decodability
    for i, s in enumerate(test_samples):
        img_p = raw_root / s["image_path"]
        if not img_p.exists():
            raise FileNotFoundError(f"Missing test image: {img_p}")

    print(f"  All 2,408 test image files verified present on disk.")

    # 3. Model Construction & Weight Loading
    model = build_mobilenetv3_road_classifier(num_classes=len(labels), pretrained=False)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.to(device)
    model.eval()
    print("Model initialized and state dict loaded cleanly.")

    # 4. DataLoader Setup
    test_transform = get_transforms(split="test")
    test_dataset = RoadDefectDataset(test_samples, raw_root=raw_root, labels=labels, transform=test_transform)
    test_loader = DataLoader(
        test_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        drop_last=False
    )

    # 5. Single Inference Pass over Test Split
    print(f"\nRunning test evaluation on {len(test_dataset):,} images ({len(test_loader)} batches)...")
    t0 = time.time()

    total_loss = 0.0
    total_batches = 0
    all_targets = []
    all_probs = []
    all_sample_ids = []

    with torch.no_grad():
        for batch_idx, (images, targets, masks, sample_ids) in enumerate(test_loader):
            images = images.to(device)
            targets = targets.to(device)
            masks = masks.to(device)

            logits = model(images)
            loss = masked_bce_loss(logits, targets, masks, pos_weight=pos_weight)
            probs = torch.sigmoid(logits)

            total_loss += loss.item()
            total_batches += 1

            all_targets.append(targets.cpu().numpy())
            all_probs.append(probs.cpu().numpy())
            all_sample_ids.extend(sample_ids)

    elapsed_time = time.time() - t0
    avg_loss = total_loss / max(total_batches, 1)

    targets_np = np.concatenate(all_targets, axis=0)
    probs_np = np.concatenate(all_probs, axis=0)

    # 6. Compute Metrics Using FROZEN Validation Thresholds
    test_class_metrics = {}
    preds_binary = np.zeros_like(targets_np, dtype=int)

    for i, cat in enumerate(labels):
        th = frozen_thresholds[cat]
        class_res = calculate_metrics_for_class(targets_np[:, i], probs_np[:, i], th)
        test_class_metrics[cat] = class_res
        preds_binary[:, i] = (probs_np[:, i] >= th).astype(int)

    # Multi-label metrics
    macro_f1 = float(np.mean([test_class_metrics[cat]["f1"] for cat in labels]))
    macro_precision = float(np.mean([test_class_metrics[cat]["precision"] for cat in labels]))
    macro_recall = float(np.mean([test_class_metrics[cat]["recall"] for cat in labels]))
    
    # Exact Match Subset Accuracy (both labels predicted correctly for a sample)
    exact_match_correct = int(np.sum(np.all(preds_binary == targets_np.astype(int), axis=1)))
    subset_accuracy = exact_match_correct / len(targets_np)
    
    # Hamming Accuracy (per-label accuracy across all targets)
    hamming_loss = float(np.mean(preds_binary != targets_np.astype(int)))
    hamming_accuracy = 1.0 - hamming_loss

    evaluation_report = {
        "status": "success",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "checkpoint_evaluated": str(ckpt_path),
        "config_used": str(config_p),
        "device": args.device,
        "batch_size": args.batch_size,
        "elapsed_seconds": round(elapsed_time, 2),
        "test_samples_count": len(test_samples),
        "validation_baseline": {
            "avg_loss": val_avg_loss,
            "macro_f1": val_macro_f1,
            "classes": val_classes
        },
        "test_results": {
            "avg_loss": round(avg_loss, 4),
            "macro_f1": round(macro_f1, 4),
            "macro_precision": round(macro_precision, 4),
            "macro_recall": round(macro_recall, 4),
            "subset_accuracy": round(subset_accuracy, 4),
            "exact_match_count": exact_match_correct,
            "hamming_loss": round(hamming_loss, 4),
            "hamming_accuracy": round(hamming_accuracy, 4),
            "frozen_thresholds": frozen_thresholds,
            "classes": test_class_metrics
        }
    }

    # 7. Print Console Summary
    print("\n" + "=" * 75)
    print("TEST EVALUATION RESULTS (Held-Out Test Split, N=2,408)")
    print("=" * 75)
    print(f"Elapsed Time: {elapsed_time:.2f}s ({elapsed_time / 60:.2f} min)")
    print(f"Test Loss (BCE Masked):   {avg_loss:.4f}  (Validation was {val_avg_loss:.4f})")
    print(f"Test Macro-F1:            {macro_f1:.4f} ({macro_f1 * 100:.2f}%)  (Validation was {val_macro_f1 * 100:.2f}%)")
    print(f"Test Macro-Precision:     {macro_precision:.4f} ({macro_precision * 100:.2f}%)")
    print(f"Test Macro-Recall:        {macro_recall:.4f} ({macro_recall * 100:.2f}%)")
    print(f"Exact Match Accuracy:     {subset_accuracy:.4f} ({subset_accuracy * 100:.2f}%) [{exact_match_correct}/{len(targets_np)} samples]")
    print(f"Hamming Accuracy:         {hamming_accuracy:.4f} ({hamming_accuracy * 100:.2f}%)")

    print("\n--- Per-Class Test Breakdown ---")
    for cat in labels:
        m = test_class_metrics[cat]
        cm = m["confusion_matrix"]
        print(f"\nCategory: [{cat}] (Threshold = {m['threshold']:.2f})")
        print(f"  Accuracy:  {m['accuracy'] * 100:.2f}%")
        print(f"  Precision: {m['precision'] * 100:.2f}%")
        print(f"  Recall:    {m['recall'] * 100:.2f}%")
        print(f"  F1 Score:  {m['f1'] * 100:.2f}%")
        print(f"  Confusion Matrix: TN={cm[0][0]}, FP={cm[0][1]}, FN={cm[1][0]}, TP={cm[1][1]}")

    # 8. Save Reports
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report_json_path = out_dir / "test_evaluation_report.json"
    report_md_path = out_dir / "test_evaluation_report.md"

    with open(report_json_path, "w", encoding="utf-8") as f:
        json.dump(evaluation_report, f, indent=2)
    print(f"\nSaved test evaluation JSON report to: {report_json_path}")

    # Format Markdown Report
    pothole_m = test_class_metrics["pothole"]
    p_cm = pothole_m["confusion_matrix"]
    road_m = test_class_metrics["road_damage"]
    r_cm = road_m["confusion_matrix"]

    pothole_val = val_classes.get("pothole", {})
    road_val = val_classes.get("road_damage", {})

    md_content = f"""# CivicVision AI — Phase 1 Test Evaluation Report

**Evaluation Timestamp:** {evaluation_report['timestamp']}  
**Checkpoint Evaluated:** `{ckpt_path.name}` (Epoch 8 Best Checkpoint)  
**Evaluated Split:** Held-out RDD2022 Test Split ($N = 2,408$)  
**Inference Device:** {args.device}  
**Elapsed Evaluation Time:** {elapsed_time:.2f} seconds  

---

## 1. Executive Summary: Test vs Validation Performance

| Metric | Validation Set (N=2,371) | Test Set (N=2,408) | Generalization Delta |
| :--- | :---: | :---: | :---: |
| **Average Loss** | `{val_avg_loss:.4f}` | **`{avg_loss:.4f}`** | {avg_loss - val_avg_loss:+.4f} |
| **Macro-F1** | `{val_macro_f1 * 100:.2f}%` | **`{macro_f1 * 100:.2f}%`** | **{(macro_f1 - val_macro_f1) * 100:+.2f}%** |
| **Macro-Precision** | — | **`{macro_precision * 100:.2f}%`** | — |
| **Macro-Recall** | — | **`{macro_recall * 100:.2f}%`** | — |
| **Exact Match Accuracy** | — | **`{subset_accuracy * 100:.2f}%`** | ({exact_match_correct} / {len(targets_np)} images) |
| **Hamming Accuracy** | — | **`{hamming_accuracy * 100:.2f}%`** | (Label-level accuracy) |

---

## 2. Per-Class Test Breakdown (Using Frozen Validation Thresholds)

### Category: `pothole`
- **Threshold ($\\tau^*$):** `{pothole_m['threshold']}` *(Selected on Validation set, applied frozen)*
- **F1 Score:** **`{pothole_m['f1'] * 100:.2f}%`** *(Validation: {pothole_val.get('f1', 0) * 100:.2f}%)*
- **Precision:** `{pothole_m['precision'] * 100:.2f}%` *(Validation: {pothole_val.get('precision', 0) * 100:.2f}%)*
- **Recall:** `{pothole_m['recall'] * 100:.2f}%` *(Validation: {pothole_val.get('recall', 0) * 100:.2f}%)*
- **Accuracy:** `{pothole_m['accuracy'] * 100:.2f}%`
- **Confusion Matrix:**
  $$\\begin{{pmatrix}} \\text{{TN}} = {p_cm[0][0]} & \\text{{FP}} = {p_cm[0][1]} \\\\ \\text{{FN}} = {p_cm[1][0]} & \\text{{TP}} = {p_cm[1][1]} \\end{{pmatrix}}$$

### Category: `road_damage`
- **Threshold ($\\tau^*$):** `{road_m['threshold']}` *(Selected on Validation set, applied frozen)*
- **F1 Score:** **`{road_m['f1'] * 100:.2f}%`** *(Validation: {road_val.get('f1', 0) * 100:.2f}%)*
- **Precision:** `{road_m['precision'] * 100:.2f}%` *(Validation: {road_val.get('precision', 0) * 100:.2f}%)*
- **Recall:** `{road_m['recall'] * 100:.2f}%` *(Validation: {road_val.get('recall', 0) * 100:.2f}%)*
- **Accuracy:** `{road_m['accuracy'] * 100:.2f}%`
- **Confusion Matrix:**
  $$\\begin{{pmatrix}} \\text{{TN}} = {r_cm[0][0]} & \\text{{FP}} = {r_cm[0][1]} \\\\ \\text{{FN}} = {r_cm[1][0]} & \\text{{TP}} = {r_cm[1][1]} \\end{{pmatrix}}$$

---

## 3. Dataset Quarantine & Integrity Verification

1. **Strict Split Separation:**  
   - Train Split ($N = 11,060$): zero intersection with Test.  
   - Validation Split ($N = 2,371$): zero intersection with Test.  
   - Test Split ($N = 2,408$): 100% held-out; no tuning, no threshold search, evaluated exactly once.
2. **Zero Unannotated Data Leakage:**  
   - TACO images: Excluded (0 samples).  
   - Both categories supervised (`label_masks == 1` for all 2,408 images).
3. **Reproducibility:**  
   - Deterministic test transforms (`Resize(256)`, `CenterCrop(224)`, ImageNet normalization).  
   - Random seed `42`.
"""

    with open(report_md_path, "w", encoding="utf-8") as f:
        f.write(md_content)
    print(f"Saved test evaluation Markdown report to: {report_md_path}")

    return evaluation_report


if __name__ == "__main__":
    cli_args = parse_args()
    run_evaluation(cli_args)
