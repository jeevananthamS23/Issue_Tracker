"""
CivicVision AI — Phase 1 Road Defect Multi-Label Training Script
Architecture: MobileNetV3-Small
Target Categories: pothole, road_damage
Manifest: F6-B6 Multi-Label Manifest (RDD2022 subset)
"""

import os
import sys
import json
import time
import random
import argparse
import datetime
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any

import numpy as np
from PIL import Image

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import torchvision.transforms as T
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights


# ============================================================================
# 1. REPRODUCIBILITY & SEED MANAGEMENT
# ============================================================================

def set_seed(seed: int = 42):
    """Sets deterministic seeds across Python, NumPy, and PyTorch."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False


# ============================================================================
# 2. DATASET DEFINITION & SPLIT FILTERING
# ============================================================================

class RoadDefectDataset(Dataset):
    """
    Multi-label PyTorch Dataset for RDD2022 road defect classification.
    Reads only samples from source 'RDD2022' that have supervised labels (mask=1)
    for both selected defect categories (pothole and road_damage).
    """

    def __init__(
        self,
        samples: List[Dict[str, Any]],
        raw_root: Path,
        labels: List[str],
        transform: Optional[T.Compose] = None,
    ):
        self.raw_root = Path(raw_root)
        self.labels = labels
        self.transform = transform
        self.samples = samples

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, str]:
        item = self.samples[idx]
        img_rel_path = item["image_path"]
        img_full_path = self.raw_root / img_rel_path

        if not img_full_path.exists():
            raise FileNotFoundError(f"Image not found at path: {img_full_path}")

        try:
            with Image.open(img_full_path) as img:
                img = img.convert("RGB")
                if self.transform is not None:
                    img_tensor = self.transform(img)
                else:
                    img_tensor = T.functional.to_tensor(img)
        except Exception as e:
            raise RuntimeError(f"Error decoding image {img_full_path}: {e}")

        # Construct target vector and supervision mask vector
        target_vals = []
        mask_vals = []
        for cat in self.labels:
            val = item["labels"].get(cat, -1)
            mask = item["label_masks"].get(cat, 0)
            target_vals.append(float(max(val, 0)))  # Clamp -1 to 0 for target tensor
            mask_vals.append(float(mask))

        target_tensor = torch.tensor(target_vals, dtype=torch.float32)
        mask_tensor = torch.tensor(mask_vals, dtype=torch.float32)

        return img_tensor, target_tensor, mask_tensor, item["sample_id"]


def filter_rdd_samples(
    manifest_data: Dict[str, Any],
    split: str,
    target_labels: List[str]
) -> List[Dict[str, Any]]:
    """
    Filters manifest samples to only RDD2022 samples in the requested split
    where all target labels have supervised masks (mask == 1).
    Ensures zero unannotated TACO images enter the road-only training pipeline.
    """
    selected = []
    for s in manifest_data.get("samples", []):
        if s.get("source") != "RDD2022":
            continue
        if s.get("split") != split:
            continue
        # Verify all target labels are supervised
        masks = s.get("label_masks", {})
        if all(masks.get(cat, 0) == 1 for cat in target_labels):
            selected.append(s)
    return selected


# ============================================================================
# 3. PREPROCESSING & DATA AUGMENTATION
# ============================================================================

def get_transforms(split: str, image_size: int = 224) -> T.Compose:
    """
    Returns image preprocessing transforms.
    Train split applies gentle stochastic augmentations.
    Validation/Test splits apply deterministic resize and center crop.
    """
    mean = [0.485, 0.456, 0.406]
    std = [0.229, 0.224, 0.225]

    if split == "train":
        return T.Compose([
            T.RandomResizedCrop(image_size, scale=(0.8, 1.0), ratio=(0.9, 1.1)),
            T.RandomHorizontalFlip(p=0.5),
            T.ColorJitter(brightness=0.15, contrast=0.15, saturation=0.10),
            T.ToTensor(),
            T.Normalize(mean=mean, std=std),
        ])
    else:
        return T.Compose([
            T.Resize(int(image_size * 1.14)),  # e.g., 256 for 224 crop
            T.CenterCrop(image_size),
            T.ToTensor(),
            T.Normalize(mean=mean, std=std),
        ])


# ============================================================================
# 4. MODEL ARCHITECTURE
# ============================================================================

def build_mobilenetv3_road_classifier(
    num_classes: int = 2,
    pretrained: bool = False,
    pretrained_path: Optional[str] = None
) -> nn.Module:
    """
    Constructs a MobileNetV3-Small backbone with a custom 2-output binary logit head.
    Pretrained weights are loaded only if explicitly specified or a local file is provided.
    """
    if pretrained_path and os.path.exists(pretrained_path):
        print(f"Loading local pretrained backbone weights from: {pretrained_path}")
        model = mobilenet_v3_small(weights=None)
        state_dict = torch.load(pretrained_path, map_location="cpu")
        # Handle state dict if saved with full model or backbone only
        if "state_dict" in state_dict:
            state_dict = state_dict["state_dict"]
        # Filter matching keys
        model_dict = model.state_dict()
        filtered = {k: v for k, v in state_dict.items() if k in model_dict and v.shape == model_dict[k].shape}
        model_dict.update(filtered)
        model.load_state_dict(model_dict)
    elif pretrained:
        print("Initializing with torchvision MobileNetV3-Small DEFAULT pretrained weights...")
        model = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
    else:
        print("Initializing MobileNetV3-Small from scratch (random initialization, no pretrained weights)...")
        model = mobilenet_v3_small(weights=None)

    # Replace classifier head with 2-output binary logit head
    in_features = model.classifier[0].in_features  # 576
    model.classifier = nn.Sequential(
        nn.Linear(in_features, 1024),
        nn.Hardswish(),
        nn.Dropout(p=0.2),
        nn.Linear(1024, num_classes)
    )

    return model


# ============================================================================
# 5. LOSS FUNCTION & CLASS IMBALANCE HANDLING
# ============================================================================

def compute_positive_weights(
    train_samples: List[Dict[str, Any]],
    labels: List[str],
    min_clamp: float = 1.0,
    max_clamp: float = 10.0
) -> torch.Tensor:
    """
    Calculates positive class weight penalties (pos_weight = N_neg / N_pos)
    from training data, with documented safeguards against extreme values.
    Clamps weights between [min_clamp, max_clamp] to prevent gradient instability.
    """
    weights = []
    print("\n--- Positive Class Weight Calculation (Train Split) ---")
    for cat in labels:
        pos_cnt = sum(1 for s in train_samples if s["labels"].get(cat) == 1 and s["label_masks"].get(cat) == 1)
        neg_cnt = sum(1 for s in train_samples if s["labels"].get(cat) == 0 and s["label_masks"].get(cat) == 1)
        
        raw_ratio = neg_cnt / max(pos_cnt, 1)
        clamped_weight = float(np.clip(raw_ratio, min_clamp, max_clamp))
        weights.append(clamped_weight)
        
        print(f"  Class '{cat}': Pos={pos_cnt:,}, Neg={neg_cnt:,} | Raw Ratio={raw_ratio:.2f} -> Clamped Weight={clamped_weight:.2f}")

    return torch.tensor(weights, dtype=torch.float32)


def masked_bce_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    masks: torch.Tensor,
    pos_weight: Optional[torch.Tensor] = None
) -> torch.Tensor:
    """
    Computes element-wise Binary Cross-Entropy with Logits loss,
    weighted by pos_weight, and masked by supervision mask M.
    Loss is normalized only over supervised elements (mask == 1).
    """
    bce_raw = F.binary_cross_entropy_with_logits(
        logits, targets, pos_weight=pos_weight, reduction="none"
    )
    masked_loss = (bce_raw * masks).sum() / (masks.sum() + 1e-7)
    return masked_loss


# ============================================================================
# 6. EVALUATION METRICS & THRESHOLD CALIBRATION
# ============================================================================

def calculate_metrics_for_class(
    targets: np.ndarray,
    probs: np.ndarray,
    threshold: float
) -> Dict[str, Any]:
    """
    Calculates binary classification metrics for a single class at a given threshold.
    """
    preds = (probs >= threshold).astype(int)
    targets = targets.astype(int)

    tp = int(np.sum((preds == 1) & (targets == 1)))
    fp = int(np.sum((preds == 1) & (targets == 0)))
    tn = int(np.sum((preds == 0) & (targets == 0)))
    fn = int(np.sum((preds == 0) & (targets == 1)))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

    return {
        "threshold": round(threshold, 3),
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "confusion_matrix": [[tn, fp], [fn, tp]]
    }


def find_optimal_thresholds(
    targets: np.ndarray,
    probs: np.ndarray,
    class_names: List[str]
) -> Dict[str, Dict[str, Any]]:
    """
    Sweeps decision thresholds in [0.10, 0.90] in steps of 0.05 on validation data
    to select the threshold that maximizes per-class F1.
    """
    optimal_results = {}
    threshold_candidates = np.arange(0.10, 0.95, 0.05)

    for i, cat in enumerate(class_names):
        y_true = targets[:, i]
        y_prob = probs[:, i]

        best_f1 = -1.0
        best_metric = None

        for th in threshold_candidates:
            res = calculate_metrics_for_class(y_true, y_prob, float(th))
            if res["f1"] > best_f1:
                best_f1 = res["f1"]
                best_metric = res

        optimal_results[cat] = best_metric

    return optimal_results


# ============================================================================
# 7. TRAINING & EVALUATION LOOPS
# ============================================================================

def train_one_epoch(
    model: nn.Module,
    dataloader: DataLoader,
    optimizer: torch.optim.Optimizer,
    pos_weight: torch.Tensor,
    device: torch.device,
    max_batches: Optional[int] = None
) -> Tuple[float, float]:
    """Runs a single training epoch over the dataloader."""
    model.train()
    total_loss = 0.0
    total_batches = 0
    t0 = time.time()

    for batch_idx, (images, targets, masks, _) in enumerate(dataloader):
        if max_batches is not None and batch_idx >= max_batches:
            break

        images = images.to(device)
        targets = targets.to(device)
        masks = masks.to(device)

        optimizer.zero_grad()
        logits = model(images)
        loss = masked_bce_loss(logits, targets, masks, pos_weight=pos_weight)

        if not torch.isfinite(loss):
            raise FloatingPointError(f"Non-finite loss ({loss.item()}) encountered at batch {batch_idx}")

        loss.backward()

        for p in model.parameters():
            if p.grad is not None and not torch.all(torch.isfinite(p.grad)):
                raise FloatingPointError(f"Non-finite gradient encountered at batch {batch_idx}")

        optimizer.step()

        total_loss += loss.item()
        total_batches += 1

    elapsed = time.time() - t0
    avg_loss = total_loss / max(total_batches, 1)
    return avg_loss, elapsed


def evaluate_split(
    model: nn.Module,
    dataloader: DataLoader,
    pos_weight: torch.Tensor,
    device: torch.device,
    class_names: List[str],
    thresholds: Optional[Dict[str, float]] = None,
    max_batches: Optional[int] = None
) -> Dict[str, Any]:
    """
    Evaluates model on validation or test split.
    If thresholds are None, optimizes thresholds on the predictions.
    """
    model.eval()
    total_loss = 0.0
    total_batches = 0

    all_targets = []
    all_probs = []

    with torch.no_grad():
        for batch_idx, (images, targets, masks, _) in enumerate(dataloader):
            if max_batches is not None and batch_idx >= max_batches:
                break

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

    avg_loss = total_loss / max(total_batches, 1)
    targets_np = np.concatenate(all_targets, axis=0) if all_targets else np.zeros((0, len(class_names)))
    probs_np = np.concatenate(all_probs, axis=0) if all_probs else np.zeros((0, len(class_names)))

    if len(targets_np) == 0:
        return {"avg_loss": avg_loss, "macro_f1": 0.0, "classes": {}}

    if thresholds is None:
        # Search optimal thresholds on this split (validation)
        class_metrics = find_optimal_thresholds(targets_np, probs_np, class_names)
    else:
        # Evaluate with preset thresholds
        class_metrics = {}
        for i, cat in enumerate(class_names):
            th = thresholds.get(cat, 0.50)
            class_metrics[cat] = calculate_metrics_for_class(targets_np[:, i], probs_np[:, i], th)

    macro_f1 = float(np.mean([class_metrics[cat]["f1"] for cat in class_names]))

    return {
        "avg_loss": round(avg_loss, 4),
        "macro_f1": round(macro_f1, 4),
        "classes": class_metrics
    }


# ============================================================================
# 8. CHECKPOINTING & METADATA SERIALIZATION
# ============================================================================

def save_training_artifacts(
    output_dir: Path,
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    config: Dict[str, Any],
    val_metrics: Dict[str, Any],
    history: List[Dict[str, Any]],
    is_best: bool = False
):
    """
    Saves model checkpoint and metadata safely using atomic writes.
    Saves under output_dir/best_model.pt and config.json.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Save config JSON
    config_path = output_dir / "config.json"
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

    # 2. Save training history JSON
    history_path = output_dir / "training_history.json"
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)

    # 3. Save PyTorch state dict
    ckpt_name = "best_model.pt" if is_best else "latest_checkpoint.pt"
    ckpt_path = output_dir / ckpt_name
    temp_path = output_dir / f"{ckpt_name}.tmp"

    checkpoint_payload = {
        "model_state_dict": model.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
        "config": config,
        "val_metrics": val_metrics,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }

    torch.save(checkpoint_payload, temp_path)
    if os.path.exists(ckpt_path):
        os.remove(ckpt_path)
    os.rename(temp_path, ckpt_path)


def save_run_summary(
    output_dir: Path,
    status: str,
    best_epoch: Optional[int] = None,
    best_macro_f1: Optional[float] = None,
    total_epochs: int = 0,
    error_message: Optional[str] = None
):
    """Saves a concise JSON run summary (status, best epoch, best score, or failure reason)."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = output_dir / "run_summary.json"
    temp_path = output_dir / "run_summary.json.tmp"

    payload = {
        "status": status,
        "best_epoch": best_epoch,
        "best_val_macro_f1": round(best_macro_f1, 4) if best_macro_f1 is not None else None,
        "total_epochs_completed": total_epochs,
        "error_message": error_message,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    if os.path.exists(summary_path):
        os.remove(summary_path)
    os.rename(temp_path, summary_path)


# ============================================================================
# 9. MAIN PIPELINE
# ============================================================================

def parse_args():
    parser = argparse.ArgumentParser(description="CivicVision AI — Train MobileNetV3 Road Defect Classifier")
    parser.add_argument("--manifest_path", type=str, default="data/manifest_out/f6_b6/multilabel_manifest.json",
                        help="Path to multi-label manifest JSON file")
    parser.add_argument("--raw_root", type=str, default="data/raw",
                        help="Path to raw image directory")
    parser.add_argument("--output_dir", type=str, default="checkpoints/phase1_road_classifier",
                        help="Directory to save model checkpoints and logs")
    parser.add_argument("--labels", nargs="+", default=["pothole", "road_damage"],
                        help="Target defect labels to train")
    parser.add_argument("--batch_size", type=int, default=16,
                        help="Batch size (conservative default: 16 for CPU)")
    parser.add_argument("--epochs", type=int, default=10,
                        help="Maximum training epochs")
    parser.add_argument("--lr", type=float, default=3e-4,
                        help="Initial learning rate")
    parser.add_argument("--weight_decay", type=float, default=1e-2,
                        help="Weight decay for AdamW optimizer")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed for reproducibility")
    parser.add_argument("--device", type=str, default="cpu",
                        help="Compute device (cpu or cuda)")
    parser.add_argument("--num_workers", type=int, default=0,
                        help="Number of DataLoader workers (0 for safe Windows CPU)")
    parser.add_argument("--pretrained", action="store_true", default=False,
                        help="Use torchvision ImageNet pretrained weights if available")
    parser.add_argument("--pretrained_path", type=str, default=None,
                        help="Path to local pretrained weights file (.pth or .pt)")
    parser.add_argument("--patience", type=int, default=3,
                        help="Early stopping patience in epochs based on Val Macro-F1")
    parser.add_argument("--smoke_test", action="store_true", default=False,
                        help="Run small smoke test on 2 batches only to verify loss/gradients without full training")
    parser.add_argument("--smoke_batches", type=int, default=2,
                        help="Number of batches to run during smoke test")
    parser.add_argument("--overwrite", action="store_true", default=False,
                        help="Allow overwriting existing output_dir checkpoints")
    return parser.parse_args()


def run_training(args) -> Dict[str, Any]:
    print("=" * 70)
    print("CivicVision AI — MobileNetV3-Small Road Defect Training Pipeline")
    print("=" * 70)
    print(f"Timestamp: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
    print(f"Target Labels: {args.labels}")
    print(f"Device: {args.device} | Batch Size: {args.batch_size} | Seed: {args.seed}")
    print(f"Pretrained Mode: {args.pretrained} (path: {args.pretrained_path})")
    print(f"Smoke Test Mode: {args.smoke_test}")

    set_seed(args.seed)
    device = torch.device(args.device)

    # 1. Output Directory Safeguard
    output_dir = Path(args.output_dir)
    if output_dir.exists() and not args.overwrite and not args.smoke_test:
        if (output_dir / "best_model.pt").exists():
            raise FileExistsError(
                f"Checkpoint directory {output_dir} already contains 'best_model.pt'. "
                "Specify a new --output_dir or pass --overwrite."
            )
    output_dir.mkdir(parents=True, exist_ok=True)

    # 2. Load Manifest
    manifest_p = Path(args.manifest_path)
    if not manifest_p.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_p}")

    print(f"\nLoading manifest from: {manifest_p}")
    with open(manifest_p, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    # 3. Filter Samples for Train and Validation
    train_samples = filter_rdd_samples(manifest_data, split="train", target_labels=args.labels)
    val_samples = filter_rdd_samples(manifest_data, split="val", target_labels=args.labels)

    print(f"Supervised RDD2022 Samples: Train={len(train_samples):,}, Validation={len(val_samples):,}")
    assert len(train_samples) > 0, "No valid RDD2022 train samples found for target labels!"
    assert len(val_samples) > 0, "No valid RDD2022 validation samples found for target labels!"

    # 4. Compute Positive Class Weights (Train split only)
    pos_weight = compute_positive_weights(train_samples, args.labels).to(device)

    # 5. Build Datasets and DataLoaders
    train_transform = get_transforms(split="train")
    val_transform = get_transforms(split="val")

    raw_root = Path(args.raw_root)
    train_dataset = RoadDefectDataset(train_samples, raw_root=raw_root, labels=args.labels, transform=train_transform)
    val_dataset = RoadDefectDataset(val_samples, raw_root=raw_root, labels=args.labels, transform=val_transform)

    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=args.num_workers,
        pin_memory=False,
        drop_last=False
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.num_workers,
        pin_memory=False,
        drop_last=False
    )

    # 6. Build Model & Optimizer
    model = build_mobilenetv3_road_classifier(
        num_classes=len(args.labels),
        pretrained=args.pretrained,
        pretrained_path=args.pretrained_path
    ).to(device)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=1e-6)

    config = {
        "model_architecture": "MobileNetV3-Small",
        "labels": args.labels,
        "batch_size": args.batch_size,
        "epochs": args.epochs if not args.smoke_test else 1,
        "lr": args.lr,
        "weight_decay": args.weight_decay,
        "seed": args.seed,
        "device": args.device,
        "pretrained": args.pretrained,
        "pretrained_path": args.pretrained_path,
        "pos_weights": [round(float(w), 3) for w in pos_weight.cpu().numpy()],
        "train_samples_count": len(train_samples),
        "val_samples_count": len(val_samples),
        "smoke_test": args.smoke_test
    }

    # 7. SMOKE TEST EXECUTION
    if args.smoke_test:
        print("\n" + "=" * 50)
        print("RUNNING SMOKE TEST (Limited Batches Only)")
        print("=" * 50)
        
        train_loss, train_time = train_one_epoch(
            model=model,
            dataloader=train_loader,
            optimizer=optimizer,
            pos_weight=pos_weight,
            device=device,
            max_batches=args.smoke_batches
        )
        print(f"Smoke Test Train Step: Loss = {train_loss:.4f} (elapsed: {train_time:.2f}s)")
        assert not np.isnan(train_loss), "Train loss is NaN!"
        assert not np.isinf(train_loss), "Train loss is Infinite!"

        # Check gradients
        has_grad = any(p.grad is not None and torch.sum(torch.abs(p.grad)) > 0 for p in model.parameters())
        print(f"Gradient Check: Verified non-zero gradients = {has_grad}")
        assert has_grad, "Model gradients were not computed!"

        val_metrics = evaluate_split(
            model=model,
            dataloader=val_loader,
            pos_weight=pos_weight,
            device=device,
            class_names=args.labels,
            max_batches=args.smoke_batches
        )
        print(f"Smoke Test Val Step: Loss = {val_metrics['avg_loss']:.4f} | Macro-F1 = {val_metrics['macro_f1']:.4f}")

        # Test artifact saving
        smoke_out = output_dir / "smoke_test_run"
        history = [{
            "epoch": 1,
            "train_loss": train_loss,
            "val_loss": val_metrics["avg_loss"],
            "val_macro_f1": val_metrics["macro_f1"],
            "val_classes": val_metrics["classes"]
        }]
        save_training_artifacts(
            output_dir=smoke_out,
            model=model,
            optimizer=optimizer,
            config=config,
            val_metrics=val_metrics,
            history=history,
            is_best=True
        )
        print(f"Smoke Test Artifacts saved successfully under: {smoke_out}")

        save_run_summary(
            output_dir=smoke_out,
            status="smoke_test_success",
            best_epoch=1,
            best_macro_f1=val_metrics["macro_f1"],
            total_epochs=1
        )

        # Test reloadability
        loaded_ckpt = torch.load(smoke_out / "best_model.pt", map_location="cpu")
        test_model = build_mobilenetv3_road_classifier(num_classes=len(args.labels))
        test_model.load_state_dict(loaded_ckpt["model_state_dict"])
        print("Smoke Test Model Reload: Successfully reloaded state dictionary into new instance!")

        print("\nSMOKE TEST COMPLETED SUCCESSFULLY!")
        return {
            "status": "smoke_test_success",
            "train_loss": train_loss,
            "val_loss": val_metrics["avg_loss"],
            "val_macro_f1": val_metrics["macro_f1"],
            "artifacts_dir": str(smoke_out)
        }

    # 8. FULL TRAINING LOOP (When not smoke testing)
    best_macro_f1 = -1.0
    best_epoch = None
    patience_counter = 0
    history = []

    print(f"\nBeginning training for {args.epochs} epochs...")
    try:
        for epoch in range(1, args.epochs + 1):
            t_epoch_start = time.time()

            train_loss, train_time = train_one_epoch(
                model=model,
                dataloader=train_loader,
                optimizer=optimizer,
                pos_weight=pos_weight,
                device=device
            )

            # Evaluate on validation split
            val_metrics = evaluate_split(
                model=model,
                dataloader=val_loader,
                pos_weight=pos_weight,
                device=device,
                class_names=args.labels
            )
            scheduler.step()

            val_macro_f1 = val_metrics["macro_f1"]
            epoch_time = time.time() - t_epoch_start

            epoch_record = {
                "epoch": epoch,
                "train_loss": round(train_loss, 4),
                "val_loss": val_metrics["avg_loss"],
                "val_macro_f1": val_macro_f1,
                "val_classes": val_metrics["classes"],
                "lr": optimizer.param_groups[0]["lr"],
                "epoch_time_sec": round(epoch_time, 2)
            }
            history.append(epoch_record)

            print(f"Epoch [{epoch:02d}/{args.epochs:02d}] "
                  f"Train Loss: {train_loss:.4f} | "
                  f"Val Loss: {val_metrics['avg_loss']:.4f} | "
                  f"Val Macro-F1: {val_macro_f1:.4f} | "
                  f"Time: {epoch_time:.1f}s")
            for cat in args.labels:
                cm = val_metrics["classes"][cat]
                print(f"   -> {cat:12s}: P={cm['precision']:.3f}, R={cm['recall']:.3f}, F1={cm['f1']:.3f} (th={cm['threshold']})")

            # Save latest checkpoint
            save_training_artifacts(
                output_dir=output_dir,
                model=model,
                optimizer=optimizer,
                config=config,
                val_metrics=val_metrics,
                history=history,
                is_best=False
            )

            # Early stopping and best model checkpoint
            if val_macro_f1 > best_macro_f1:
                best_macro_f1 = val_macro_f1
                best_epoch = epoch
                patience_counter = 0
                save_training_artifacts(
                    output_dir=output_dir,
                    model=model,
                    optimizer=optimizer,
                    config=config,
                    val_metrics=val_metrics,
                    history=history,
                    is_best=True
                )
                print(f"   *** Best Validation Macro-F1 Improved to {best_macro_f1:.4f}! Saved best_model.pt ***")
            else:
                patience_counter += 1
                print(f"   (No improvement in Val Macro-F1 for {patience_counter}/{args.patience} epochs)")
                if patience_counter >= args.patience:
                    print(f"\nEarly stopping triggered after {epoch} epochs (patience reached).")
                    save_run_summary(
                        output_dir=output_dir,
                        status="early_stopped",
                        best_epoch=best_epoch,
                        best_macro_f1=best_macro_f1,
                        total_epochs=epoch
                    )
                    break
        else:
            save_run_summary(
                output_dir=output_dir,
                status="completed",
                best_epoch=best_epoch,
                best_macro_f1=best_macro_f1,
                total_epochs=len(history)
            )

    except Exception as e:
        save_run_summary(
            output_dir=output_dir,
            status="failed",
            best_epoch=best_epoch,
            best_macro_f1=best_macro_f1,
            total_epochs=len(history),
            error_message=str(e)
        )
        print(f"\n[ERROR] Training halted unexpectedly: {e}")
        raise

    print(f"\nTraining Complete. Best Validation Macro-F1: {best_macro_f1:.4f}")
    print(f"Artifacts preserved in: {output_dir}")
    return {
        "status": "training_complete",
        "best_macro_f1": best_macro_f1,
        "best_epoch": best_epoch,
        "epochs_completed": len(history),
        "history": history
    }


if __name__ == "__main__":
    cli_args = parse_args()
    run_training(cli_args)
