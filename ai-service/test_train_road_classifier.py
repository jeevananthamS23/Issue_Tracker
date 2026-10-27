"""
Unit Tests for Phase 1 Road Defect Training Pipeline (train_road_classifier.py)
Tests: label masks, split isolation, multi-label co-occurrence, positive weights,
loss calculation, model architecture, checkpoint saving/reloading, and thresholding.
"""

import os
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn

from scripts.train_road_classifier import (
    filter_rdd_samples,
    compute_positive_weights,
    masked_bce_loss,
    calculate_metrics_for_class,
    find_optimal_thresholds,
    build_mobilenetv3_road_classifier,
    save_training_artifacts,
    set_seed
)


class TestTrainRoadClassifier(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        set_seed(42)
        cls.manifest_path = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
        if cls.manifest_path.exists():
            with open(cls.manifest_path, "r", encoding="utf-8") as f:
                cls.manifest_data = json.load(f)
        else:
            cls.manifest_data = {"samples": []}

    def test_filter_rdd_samples_excludes_taco_and_preserves_splits(self):
        """Verifies filter_rdd_samples includes only RDD2022 and excludes TACO."""
        if not self.manifest_data["samples"]:
            self.skipTest("Manifest file not found.")

        labels = ["pothole", "road_damage"]
        train_samples = filter_rdd_samples(self.manifest_data, split="train", target_labels=labels)
        val_samples = filter_rdd_samples(self.manifest_data, split="val", target_labels=labels)
        test_samples = filter_rdd_samples(self.manifest_data, split="test", target_labels=labels)

        # 1. Total counts must match audited RDD2022 numbers
        self.assertEqual(len(train_samples), 11060)
        self.assertEqual(len(val_samples), 2371)
        self.assertEqual(len(test_samples), 2408)

        # 2. Assert zero TACO samples are included
        for s in train_samples + val_samples + test_samples:
            self.assertEqual(s["source"], "RDD2022")
            self.assertEqual(s["label_masks"]["pothole"], 1)
            self.assertEqual(s["label_masks"]["road_damage"], 1)

        # 3. Assert zero split leakage across sample IDs
        train_ids = {s["sample_id"] for s in train_samples}
        val_ids = {s["sample_id"] for s in val_samples}
        test_ids = {s["sample_id"] for s in test_samples}

        self.assertEqual(len(train_ids.intersection(val_ids)), 0)
        self.assertEqual(len(train_ids.intersection(test_ids)), 0)
        self.assertEqual(len(val_ids.intersection(test_ids)), 0)

    def test_multilabel_cooccurrence_presence(self):
        """Verifies multi-label co-occurrence is preserved in filtered samples."""
        if not self.manifest_data["samples"]:
            self.skipTest("Manifest file not found.")

        labels = ["pothole", "road_damage"]
        train_samples = filter_rdd_samples(self.manifest_data, split="train", target_labels=labels)

        # Count co-occurrences in train split
        co_occur = [s for s in train_samples if s["labels"]["pothole"] == 1 and s["labels"]["road_damage"] == 1]
        clean_roads = [s for s in train_samples if s["labels"]["pothole"] == 0 and s["labels"]["road_damage"] == 0]

        self.assertEqual(len(co_occur), 1160)
        self.assertEqual(len(clean_roads), 3300)

    def test_compute_positive_weights_and_clamping(self):
        """Verifies positive class weight computation with safeguards against extreme values."""
        # Mock dataset with severe imbalances
        mock_samples = [
            {"labels": {"pothole": 1, "road_damage": 1}, "label_masks": {"pothole": 1, "road_damage": 1}},
            {"labels": {"pothole": 0, "road_damage": 1}, "label_masks": {"pothole": 1, "road_damage": 1}},
            {"labels": {"pothole": 0, "road_damage": 1}, "label_masks": {"pothole": 1, "road_damage": 1}},
            {"labels": {"pothole": 0, "road_damage": 0}, "label_masks": {"pothole": 1, "road_damage": 1}},
        ]
        # Pothole: 1 pos, 3 neg -> ratio = 3.0 -> clamped to 3.0
        # Road damage: 3 pos, 1 neg -> ratio = 1/3 -> clamped to min_clamp=1.0
        weights = compute_positive_weights(mock_samples, ["pothole", "road_damage"], min_clamp=1.0, max_clamp=10.0)
        self.assertAlmostEqual(weights[0].item(), 3.0, places=2)
        self.assertAlmostEqual(weights[1].item(), 1.0, places=2)

    def test_masked_bce_loss_computation(self):
        """Verifies masked BCE loss ignores masked elements (mask=0)."""
        logits = torch.tensor([[2.0, -1.0], [0.5, 1.5]], dtype=torch.float32)
        targets = torch.tensor([[1.0, 0.0], [0.0, 1.0]], dtype=torch.float32)

        # Case 1: All masked in (mask == 1)
        masks_all = torch.tensor([[1.0, 1.0], [1.0, 1.0]], dtype=torch.float32)
        loss_all = masked_bce_loss(logits, targets, masks_all)
        self.assertTrue(torch.isfinite(loss_all))
        self.assertGreater(loss_all.item(), 0.0)

        # Case 2: Second column masked out (mask == 0)
        masks_col0 = torch.tensor([[1.0, 0.0], [1.0, 0.0]], dtype=torch.float32)
        loss_col0 = masked_bce_loss(logits, targets, masks_col0)
        self.assertTrue(torch.isfinite(loss_col0))

        # Manually compute loss for col0
        bce_col0_manual = nn.functional.binary_cross_entropy_with_logits(
            logits[:, 0:1], targets[:, 0:1]
        )
        self.assertAlmostEqual(loss_col0.item(), bce_col0_manual.item(), places=5)

    def test_model_architecture_and_output_shape(self):
        """Verifies MobileNetV3-Small architecture head and output dimension."""
        model = build_mobilenetv3_road_classifier(num_classes=2, pretrained=False)
        self.assertIsInstance(model, nn.Module)

        # Forward pass dummy batch [B=4, C=3, H=224, W=224]
        dummy_input = torch.randn(4, 3, 224, 224)
        output = model(dummy_input)

        self.assertEqual(output.shape, (4, 2))
        self.assertTrue(torch.all(torch.isfinite(output)))

    def test_metrics_calculation_and_optimal_threshold(self):
        """Verifies confusion matrix and optimal threshold calibration."""
        targets = np.array([1, 1, 0, 0])
        probs = np.array([0.9, 0.4, 0.6, 0.1])

        # At threshold 0.5:
        # preds: [1, 0, 1, 0] -> TP=1, FP=1, TN=1, FN=1
        metrics_50 = calculate_metrics_for_class(targets, probs, threshold=0.50)
        self.assertEqual(metrics_50["tp"], 1)
        self.assertEqual(metrics_50["fp"], 1)
        self.assertEqual(metrics_50["tn"], 1)
        self.assertEqual(metrics_50["fn"], 1)
        self.assertEqual(metrics_50["precision"], 0.5)
        self.assertEqual(metrics_50["recall"], 0.5)
        self.assertEqual(metrics_50["f1"], 0.5)
        self.assertEqual(metrics_50["confusion_matrix"], [[1, 1], [1, 1]])

        # At threshold 0.35:
        # preds: [1, 1, 1, 0] -> TP=2, FP=1, TN=1, FN=0
        # precision=2/3=0.6667, recall=2/2=1.0, f1=0.8
        metrics_35 = calculate_metrics_for_class(targets, probs, threshold=0.35)
        self.assertEqual(metrics_35["tp"], 2)
        self.assertEqual(metrics_35["fn"], 0)
        self.assertAlmostEqual(metrics_35["f1"], 0.8, places=2)

        # Optimal threshold search should find a threshold that yields F1 >= 0.8
        optimal = find_optimal_thresholds(targets[:, None], probs[:, None], ["test_class"])
        best_f1 = optimal["test_class"]["f1"]
        self.assertGreaterEqual(best_f1, 0.8)

    def test_checkpoint_saving_and_reloading(self):
        """Verifies checkpoint saving, config JSON, and reloadability."""
        with tempfile.TemporaryDirectory() as tmpdir:
            model = build_mobilenetv3_road_classifier(num_classes=2, pretrained=False)
            optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
            config = {"model": "MobileNetV3-Small", "seed": 42}
            val_metrics = {"macro_f1": 0.85}
            history = [{"epoch": 1, "val_macro_f1": 0.85}]

            save_training_artifacts(
                output_dir=Path(tmpdir),
                model=model,
                optimizer=optimizer,
                config=config,
                val_metrics=val_metrics,
                history=history,
                is_best=True
            )

            # Assert files exist
            self.assertTrue((Path(tmpdir) / "config.json").exists())
            self.assertTrue((Path(tmpdir) / "training_history.json").exists())
            self.assertTrue((Path(tmpdir) / "best_model.pt").exists())

            # Reload into fresh model
            checkpoint = torch.load(Path(tmpdir) / "best_model.pt", map_location="cpu")
            self.assertIn("model_state_dict", checkpoint)
            self.assertIn("config", checkpoint)

            new_model = build_mobilenetv3_road_classifier(num_classes=2, pretrained=False)
            new_model.load_state_dict(checkpoint["model_state_dict"])

            # Verify identical output on dummy input
            dummy_input = torch.randn(2, 3, 224, 224)
            model.eval()
            new_model.eval()
            with torch.no_grad():
                out1 = model(dummy_input)
                out2 = new_model(dummy_input)
            self.assertTrue(torch.allclose(out1, out2, atol=1e-6))


if __name__ == "__main__":
    unittest.main()
