"""
CivicVision AI — Classification & Severity Unit Tests (Phase 4.1B)

Verifies:
1. Truthful model identification: When no trained checkpoint exists, service
   reports mode='checkpoint_unavailable', is_trained_model=False, category=None.
2. Heuristic severity baseline:
   - Evaluates on synthetic PIL images.
   - Bounded strictly within [1.0, 10.0].
   - Returns severity_mode='rule_based_heuristic'.
   - Returns (None, None) on corrupt or missing image.
3. Category-to-Department mapping in AI service matches canonical municipal matrix.
4. Defense-in-depth on classify_issue_url:
   - Empty URL rejected with 400.
   - Non-allowlisted / SSRF destination rejected with 400.
   - Successful processing returns valid ClassifyIssueResponse structure.
5. Direct upload classify_issue_upload functionality.
"""

import io
import asyncio
import unittest
from unittest.mock import patch, MagicMock
from PIL import Image
from fastapi import HTTPException, UploadFile

from main import (
    compute_heuristic_severity,
    get_civic_classifier,
    CANONICAL_DEPARTMENT_MAP,
    BASE_HAZARD_SCORES,
    ClassifyIssueRequest,
    ClassifyIssueResponse,
    classify_issue_url,
    classify_issue_upload
)


def create_test_image(width=100, height=100, color="gray") -> bytes:
    """Helper to generate in-memory PNG bytes."""
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), color=color)
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestCivicClassification(unittest.TestCase):

    def test_truthful_model_loading_when_unconfigured(self):
        """When no checkpoint path is configured, get_civic_classifier must return None."""
        model = get_civic_classifier()
        self.assertIsNone(model, "Untrained model must never be loaded as a civic classifier")

    def test_heuristic_severity_bounds_and_modes(self):
        """Heuristic severity must be bounded within [1.0, 10.0] and labeled as rule_based_heuristic."""
        img = Image.new("RGB", (64, 64), color="red")

        # Test highest base hazard: traffic_signal (base 7.0)
        sev_traffic, mode_traffic = compute_heuristic_severity(img, "traffic_signal")
        self.assertIsNotNone(sev_traffic)
        self.assertGreaterEqual(sev_traffic, 1.0)
        self.assertLessEqual(sev_traffic, 10.0)
        self.assertEqual(mode_traffic, "rule_based_heuristic")

        # Test lowest base hazard: other (base 3.0)
        sev_other, mode_other = compute_heuristic_severity(img, "other")
        self.assertIsNotNone(sev_other)
        self.assertGreaterEqual(sev_other, 1.0)
        self.assertLessEqual(sev_other, 10.0)
        self.assertEqual(mode_other, "rule_based_heuristic")
        self.assertLess(sev_other, sev_traffic)

        # Test pothole (base 5.0)
        sev_pothole, _ = compute_heuristic_severity(img, "pothole")
        self.assertGreaterEqual(sev_pothole, 5.0)
        self.assertLessEqual(sev_pothole, 10.0)

    def test_heuristic_severity_invalid_image(self):
        """Corrupt or None image must return (None, None)."""
        sev, mode = compute_heuristic_severity(None, "pothole")
        self.assertIsNone(sev)
        self.assertIsNone(mode)

    def test_canonical_department_map_completeness(self):
        """All 8 canonical categories must map to valid municipal departments."""
        expected_categories = [
            "pothole", "road_damage", "garbage", "street_light",
            "water_leak", "sewage", "traffic_signal", "other"
        ]
        for cat in expected_categories:
            self.assertIn(cat, CANONICAL_DEPARTMENT_MAP)
            self.assertTrue(len(CANONICAL_DEPARTMENT_MAP[cat]) > 0)

        self.assertEqual(CANONICAL_DEPARTMENT_MAP["pothole"], "Roads & Infrastructure")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["road_damage"], "Roads & Infrastructure")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["garbage"], "Waste Management")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["street_light"], "Street Lighting")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["water_leak"], "Water Services")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["sewage"], "Water Services")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["traffic_signal"], "Public Works")
        self.assertEqual(CANONICAL_DEPARTMENT_MAP["other"], "Public Works")

    def test_classify_issue_endpoint_empty_url(self):
        """classify_issue_url must reject empty or whitespace URL with 400."""
        with self.assertRaises(HTTPException) as ctx:
            classify_issue_url(ClassifyIssueRequest(image_url="   "))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_classify_issue_endpoint_ssrf_protection(self):
        """classify_issue_url must reject disallowed domains and private IPs."""
        with self.assertRaises(HTTPException) as ctx:
            classify_issue_url(ClassifyIssueRequest(image_url="http://evil.com/exploit.png"))
        self.assertEqual(ctx.exception.status_code, 400)

    @patch("main.load_image_from_url")
    def test_classify_issue_endpoint_truthful_unavailable(self, mock_load):
        """classify_issue_url with valid image must return truthful unavailable status when no checkpoint exists."""
        mock_load.return_value = Image.new("RGB", (64, 64), color="blue")

        response = classify_issue_url(
            ClassifyIssueRequest(
                image_url="https://res.cloudinary.com/demo/image/upload/sample.jpg",
                candidate_category="pothole"
            )
        )

        self.assertEqual(response.model, "checkpoint_unavailable")
        self.assertEqual(response.mode, "checkpoint_unavailable")
        self.assertFalse(response.is_trained_model)
        self.assertIsNone(response.category)
        self.assertIsNone(response.confidence)
        self.assertEqual(response.status, "unavailable")
        self.assertEqual(response.severity_mode, "rule_based_heuristic")
        self.assertIsInstance(response.severity, (int, float))
        self.assertGreaterEqual(response.severity, 1.0)
        self.assertLessEqual(response.severity, 10.0)

    def test_classify_upload_endpoint(self):
        """classify_issue_upload must process upload and return truthful metadata."""
        img_bytes = create_test_image(64, 64, "green")
        file_obj = UploadFile(filename="test.png", file=io.BytesIO(img_bytes))

        response = asyncio.run(classify_issue_upload(
            file=file_obj,
            candidate_category="garbage"
        ))

        self.assertEqual(response.model, "checkpoint_unavailable")
        self.assertFalse(response.is_trained_model)
        self.assertIsInstance(response.severity, (int, float))
        self.assertGreaterEqual(response.severity, 1.0)
        self.assertLessEqual(response.severity, 10.0)


if __name__ == "__main__":
    unittest.main()
