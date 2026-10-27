"""
CivicVision AI — Phase 1 Road Defect Classifier FastAPI Integration Tests
Tests:
1. Trained model loading from Epoch 8 checkpoint (`best_model.pt`).
2. Calibrated validation thresholds (`pothole: 0.75`, `road_damage: 0.35`).
3. Endpoint POST /predict-road-defect with valid multipart image upload.
4. Endpoint POST /classify-issue (URL) and POST /classify-upload (file) with trained model.
5. Error handling:
   - Invalid / corrupted image upload rejected with 400.
   - Non-existent / corrupted model checkpoint handled gracefully (mode='checkpoint_unavailable').
   - Inference forward-pass failure handled gracefully (mode='inference_error', status='error').
   - Non-blocking behavior preserving heuristic severity score.
"""

import io
import os
import asyncio
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from PIL import Image
from fastapi import HTTPException, UploadFile

import torch

# Import application components
from main import (
    app,
    get_civic_classifier,
    classify_road_defect_image,
    DEFAULT_CIVIC_MODEL_PATH,
    ROAD_CLASSIFIER_THRESHOLDS,
    ClassifyIssueResponse,
    ClassifyIssueRequest,
    classify_issue_url,
    classify_issue_upload,
    predict_road_defect
)


def create_synthetic_image_bytes(width=224, height=224, color="gray") -> bytes:
    """Helper to generate in-memory PNG bytes."""
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), color=color)
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestRoadClassifierApiIntegration(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.checkpoint_path = Path(DEFAULT_CIVIC_MODEL_PATH)
        cls.checkpoint_available = cls.checkpoint_path.exists()

    def setUp(self):
        # Reset cached model state between test cases to prevent state leakage
        import main
        main._civic_model = None
        main._civic_model_metadata = None
        main._civic_model_attempted = False
        main._civic_model_error = None

    def tearDown(self):
        import main
        main._civic_model = None
        main._civic_model_metadata = None
        main._civic_model_attempted = False
        main._civic_model_error = None

    def test_01_trained_model_loading_from_checkpoint(self):
        """Verifies MobileNetV3-Small architecture, weights, and thresholds load from best_model.pt."""
        if not self.checkpoint_available:
            self.skipTest(f"Checkpoint not found at: {self.checkpoint_path}")

        model = get_civic_classifier(model_path=str(self.checkpoint_path), force_reload=True)
        self.assertIsNotNone(model, "Model should load successfully from best_model.pt")

        metadata = getattr(model, "metadata", {})
        self.assertIn("thresholds", metadata)
        self.assertEqual(metadata["thresholds"]["pothole"], 0.75)
        self.assertEqual(metadata["thresholds"]["road_damage"], 0.35)
        self.assertEqual(metadata["version"], "MobileNetV3-Small_phase1_road_epoch8")

        # Test dummy inference forward pass
        dummy_tensor = torch.randn(1, 3, 224, 224)
        with torch.no_grad():
            logits = model(dummy_tensor)
        self.assertEqual(logits.shape, (1, 2))
        self.assertTrue(torch.all(torch.isfinite(logits)))

    def test_02_classify_road_defect_image_with_trained_model(self):
        """Verifies classify_road_defect_image returns structured multi-label probabilities and categories."""
        if not self.checkpoint_available:
            self.skipTest("Checkpoint not available")

        # Configure model path
        get_civic_classifier(model_path=str(self.checkpoint_path), force_reload=True)
        test_img = Image.new("RGB", (224, 224), color="darkgray")

        result = classify_road_defect_image(test_img, candidate_category="pothole")

        self.assertTrue(result["is_trained_model"])
        self.assertEqual(result["mode"], "trained_checkpoint")
        self.assertIn(result["status"], ("classified", "unverified"))
        self.assertIn("pothole", result["probabilities"])
        self.assertIn("road_damage", result["probabilities"])
        self.assertIsInstance(result["probabilities"]["pothole"], float)
        self.assertIsInstance(result["probabilities"]["road_damage"], float)
        self.assertEqual(result["thresholds"]["pothole"], 0.75)
        self.assertEqual(result["thresholds"]["road_damage"], 0.35)
        self.assertGreaterEqual(result["severity"], 1.0)
        self.assertLessEqual(result["severity"], 10.0)

    def test_03_predict_road_defect_endpoint_multipart(self):
        """Verifies predict_road_defect accepts UploadFile and returns ClassifyIssueResponse with multi-label predictions."""
        if not self.checkpoint_available:
            self.skipTest("Checkpoint not available")

        get_civic_classifier(model_path=str(self.checkpoint_path), force_reload=True)

        img_bytes = create_synthetic_image_bytes(224, 224, "darkgreen")
        file_obj = UploadFile(filename="road_sample.png", file=io.BytesIO(img_bytes))

        response = asyncio.run(predict_road_defect(
            file=file_obj,
            candidate_category="pothole"
        ))

        self.assertIsInstance(response, ClassifyIssueResponse)
        self.assertTrue(response.is_trained_model)
        self.assertEqual(response.mode, "trained_checkpoint")
        self.assertIn(response.status, ("classified", "unverified"))
        self.assertIn("pothole", response.probabilities)
        self.assertIn("road_damage", response.probabilities)
        self.assertEqual(response.thresholds["pothole"], 0.75)
        self.assertEqual(response.thresholds["road_damage"], 0.35)
        self.assertEqual(response.model_version, "MobileNetV3-Small_phase1_road_epoch8")

    def test_04_classify_upload_endpoint_with_trained_model(self):
        """Verifies classify_issue_upload returns trained model predictions and backward-compatible fields."""
        if not self.checkpoint_available:
            self.skipTest("Checkpoint not available")

        get_civic_classifier(model_path=str(self.checkpoint_path), force_reload=True)

        img_bytes = create_synthetic_image_bytes(224, 224, "gray")
        file_obj = UploadFile(filename="test.png", file=io.BytesIO(img_bytes))

        response = asyncio.run(classify_issue_upload(
            file=file_obj,
            candidate_category="road_damage"
        ))

        self.assertIsInstance(response, ClassifyIssueResponse)
        self.assertTrue(response.is_trained_model)
        self.assertIsInstance(response.severity, (int, float))

    def test_05_invalid_upload_corrupt_data_rejected_with_400(self):
        """Verifies uploading corrupted or empty image bytes raises HTTP 400 Bad Request."""
        corrupted_bytes = b"NOT_A_VALID_IMAGE_DATA_123"
        file_obj = UploadFile(filename="corrupt.png", file=io.BytesIO(corrupted_bytes))

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(predict_road_defect(file=file_obj))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("Invalid image format", ctx.exception.detail)

    def test_06_model_loading_error_graceful_handling(self):
        """Verifies that an unconfigured or non-existent checkpoint path returns truthful unavailable status without crashing."""
        non_existent_path = "checkpoints/does_not_exist_model.pt"
        model = get_civic_classifier(model_path=non_existent_path, force_reload=True)
        self.assertIsNone(model)

        test_img = Image.new("RGB", (64, 64), color="blue")
        res = classify_road_defect_image(test_img, candidate_category="pothole")

        self.assertFalse(res["is_trained_model"])
        self.assertEqual(res["mode"], "checkpoint_unavailable")
        self.assertEqual(res["status"], "unavailable")
        self.assertIsNone(res["category"])
        self.assertIsNone(res["confidence"])
        self.assertIsNotNone(res["severity"])
        self.assertIn("does_not_exist_model", res["error"])

    def test_07_inference_runtime_failure_graceful_handling(self):
        """Verifies that if model forward-pass throws an internal exception, service returns status='error' with details."""
        mock_model = MagicMock()
        mock_model.metadata = {
            "version": "MockModel_v1",
            "thresholds": {"pothole": 0.75, "road_damage": 0.35},
            "transform": lambda x: torch.randn(3, 224, 224)
        }
        # Force forward pass to raise a RuntimeError (e.g. simulated memory error or kernel fault)
        mock_model.side_effect = RuntimeError("Simulated forward-pass kernel fault")

        with patch("main.get_civic_classifier", return_value=mock_model):
            test_img = Image.new("RGB", (64, 64), color="black")
            res = classify_road_defect_image(test_img, candidate_category="road_damage")

            self.assertEqual(res["status"], "error")
            self.assertEqual(res["mode"], "inference_error")
            self.assertTrue(res["is_trained_model"])
            self.assertIn("Simulated forward-pass kernel fault", res["error"])
            self.assertIsInstance(res["severity"], (int, float))
            self.assertGreaterEqual(res["severity"], 1.0)


if __name__ == "__main__":
    unittest.main()
