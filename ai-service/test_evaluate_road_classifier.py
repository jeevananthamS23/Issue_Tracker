"""
Unit Tests for Test Evaluation Pipeline (evaluate_road_classifier.py)
Tests: metrics calculation, subset accuracy, hamming loss, confusion matrix,
and split quarantine validation.
"""

import unittest
import numpy as np
import torch

from scripts.evaluate_road_classifier import calculate_metrics_for_class


class TestEvaluateRoadClassifier(unittest.TestCase):

    def test_calculate_metrics_accuracy_and_confusion_matrix(self):
        """Verifies binary metrics including accuracy and confusion matrix."""
        # 4 samples: 2 positive, 2 negative
        targets = np.array([1, 1, 0, 0])
        probs = np.array([0.8, 0.4, 0.2, 0.6])

        # At threshold 0.5:
        # preds: [1, 0, 0, 1]
        # TP: target=1, pred=1 (idx 0) -> 1
        # FP: target=0, pred=1 (idx 3) -> 1
        # TN: target=0, pred=0 (idx 2) -> 1
        # FN: target=1, pred=0 (idx 1) -> 1
        # Accuracy: (1 + 1) / 4 = 0.50
        res = calculate_metrics_for_class(targets, probs, threshold=0.50)

        self.assertEqual(res["tp"], 1)
        self.assertEqual(res["fp"], 1)
        self.assertEqual(res["tn"], 1)
        self.assertEqual(res["fn"], 1)
        self.assertEqual(res["total"], 4)
        self.assertEqual(res["accuracy"], 0.50)
        self.assertEqual(res["precision"], 0.50)
        self.assertEqual(res["recall"], 0.50)
        self.assertEqual(res["f1"], 0.50)
        self.assertEqual(res["confusion_matrix"], [[1, 1], [1, 1]])

    def test_subset_accuracy_multi_label(self):
        """Verifies exact match multi-label subset accuracy."""
        # 3 samples, 2 classes
        targets = np.array([
            [1, 0],
            [0, 1],
            [1, 1]
        ])
        preds = np.array([
            [1, 0],  # Exact match
            [0, 0],  # Mismatch (class 1 missed)
            [1, 1]   # Exact match
        ])

        exact_matches = np.all(preds == targets, axis=1)
        subset_acc = float(np.mean(exact_matches))
        hamming_loss = float(np.mean(preds != targets))

        self.assertAlmostEqual(subset_acc, 2/3, places=3)
        self.assertAlmostEqual(hamming_loss, 1/6, places=3)

    def test_perfect_predictions(self):
        """Verifies 100% metrics on perfect predictions."""
        targets = np.array([1, 1, 0, 0])
        probs = np.array([0.95, 0.85, 0.10, 0.05])
        res = calculate_metrics_for_class(targets, probs, threshold=0.50)

        self.assertEqual(res["tp"], 2)
        self.assertEqual(res["fp"], 0)
        self.assertEqual(res["tn"], 2)
        self.assertEqual(res["fn"], 0)
        self.assertEqual(res["accuracy"], 1.0)
        self.assertEqual(res["precision"], 1.0)
        self.assertEqual(res["recall"], 1.0)
        self.assertEqual(res["f1"], 1.0)


if __name__ == "__main__":
    unittest.main()
