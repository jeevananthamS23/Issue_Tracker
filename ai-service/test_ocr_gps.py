"""
CivicVision AI — OCR GPS Extraction Unit & Integration Tests (Phase F5-B / Feature F5)

Test Categories:
1. Decimal-degree parsing with labels (Lat/Long, Latitude/Longitude).
2. Decimal-degree parsing with hemisphere suffixes (11.342423 N 77.728165 E).
3. DMS parsing (11°20'32.7"N 77°43'41.4"E, deg/min/sec words, integer seconds).
4. S/W hemisphere signs (converts south/west to negative decimal values).
5. Equator and geographic boundaries (0.0, 0.0, 89.9, 179.9, -90.0, -180.0).
6. Out-of-range and malformed coordinates (rejected safely).
7. Dates, timestamps, phone numbers, speeds, and unrelated numbers (rejected safely).
8. Ambiguous or conflicting candidate pairs (detected and rejected with clear reason).
9. Empty or whitespace OCR text.
10. OCR executable unavailable (graceful non-500 response).
11. Upload endpoint input validation and size restrictions.
12. URL endpoint SSRF protections and authentication enforcement.
13. Regression: Existing AI endpoints continue to operate without interference.
14. Optional real OCR smoke test (runs only if tesseract executable is installed).
"""

import io
import asyncio
import unittest
from unittest.mock import patch, MagicMock
from PIL import Image, ImageDraw
from fastapi import HTTPException
from starlette.datastructures import UploadFile as StarletteUploadFile

from main import (
    haversine_distance,
    validate_coordinates,
    dms_to_decimal,
    parse_dms_candidates,
    parse_decimal_candidates,
    parse_coordinate_text,
    is_tesseract_available,
    extract_text_from_image,
    OcrGpsUrlRequest,
    OcrGpsResponse,
    extract_ocr_gps_url,
    extract_ocr_upload,
    health_check,
    readiness_check,
    embed_image_upload,
    classify_issue_upload,
    DETERMINISTIC_MODEL_NAME,
    MAX_IMAGE_BYTES
)


def create_synthetic_image(width=100, height=100, color="white") -> bytes:
    """Helper to generate in-memory PNG bytes."""
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), color=color)
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestOcrGpsParser(unittest.TestCase):
    """Unit tests for deterministic coordinate parsing functions."""

    # 1. Decimal-degree parsing with labels
    def test_decimal_degrees_with_labels(self):
        # Format: Lat: 11.3424, Long: 77.7281
        res1 = parse_coordinate_text("Lat: 11.3424, Long: 77.7281")
        self.assertTrue(res1["found"])
        self.assertAlmostEqual(res1["latitude"], 11.3424, places=4)
        self.assertAlmostEqual(res1["longitude"], 77.7281, places=4)
        self.assertEqual(res1["format"], "decimal_degrees")
        self.assertEqual(res1["confidence"], 0.90)

        # Format: Latitude: 11.342423 N, Longitude: 77.728165 E
        res2 = parse_coordinate_text("Latitude: 11.342423 N, Longitude: 77.728165 E")
        self.assertTrue(res2["found"])
        self.assertAlmostEqual(res2["latitude"], 11.342423, places=6)
        self.assertAlmostEqual(res2["longitude"], 77.728165, places=6)

        # Multi-line with labels
        res3 = parse_coordinate_text("Latitude: 11.342423\nLongitude: 77.728165")
        self.assertTrue(res3["found"])
        self.assertAlmostEqual(res3["latitude"], 11.342423, places=6)
        self.assertAlmostEqual(res3["longitude"], 77.728165, places=6)

        # Prefix format with degree symbol
        res4 = parse_coordinate_text("Lat: 11.3424° N, Long: 77.7281° E")
        self.assertTrue(res4["found"])
        self.assertAlmostEqual(res4["latitude"], 11.3424, places=4)
        self.assertAlmostEqual(res4["longitude"], 77.7281, places=4)

    # 2. Decimal-degree parsing with hemisphere suffixes
    def test_decimal_degrees_with_hemisphere_suffixes(self):
        # Format: 11.342423 N 77.728165 E
        res1 = parse_coordinate_text("11.342423 N 77.728165 E")
        self.assertTrue(res1["found"])
        self.assertAlmostEqual(res1["latitude"], 11.342423, places=6)
        self.assertAlmostEqual(res1["longitude"], 77.728165, places=6)
        self.assertEqual(res1["format"], "decimal_degrees")
        self.assertEqual(res1["confidence"], 0.80)

        # Format: 11.342423° N, 77.728165° E
        res2 = parse_coordinate_text("11.342423° N, 77.728165° E")
        self.assertTrue(res2["found"])
        self.assertAlmostEqual(res2["latitude"], 11.342423, places=6)
        self.assertAlmostEqual(res2["longitude"], 77.728165, places=6)

        # Format: 11.342423N 77.728165E (compact)
        res3 = parse_coordinate_text("11.342423N 77.728165E")
        self.assertTrue(res3["found"])
        self.assertAlmostEqual(res3["latitude"], 11.342423, places=6)
        self.assertAlmostEqual(res3["longitude"], 77.728165, places=6)

        # Location / GPS prefix
        res4 = parse_coordinate_text("GPS: 11.3424, 77.7281")
        self.assertTrue(res4["found"])
        self.assertAlmostEqual(res4["latitude"], 11.3424, places=4)
        self.assertAlmostEqual(res4["longitude"], 77.7281, places=4)

    # 3. DMS parsing
    def test_dms_parsing(self):
        # Standard DMS: 11°20'32.7"N 77°43'41.4"E
        res1 = parse_coordinate_text("11°20'32.7\"N 77°43'41.4\"E")
        self.assertTrue(res1["found"])
        self.assertAlmostEqual(res1["latitude"], 11.342417, places=5)
        self.assertAlmostEqual(res1["longitude"], 77.728167, places=5)
        self.assertEqual(res1["format"], "degrees_minutes_seconds")
        self.assertEqual(res1["confidence"], 0.95)

        # Written words: 11 deg 20 min 32.7 sec N, 77 deg 43 min 41.4 sec E
        res2 = parse_coordinate_text("11 deg 20 min 32.7 sec N, 77 deg 43 min 41.4 sec E")
        self.assertTrue(res2["found"])
        self.assertAlmostEqual(res2["latitude"], 11.342417, places=5)
        self.assertAlmostEqual(res2["longitude"], 77.728167, places=5)

        # Integer seconds: 11°20'32"N 77°43'41"E
        res3 = parse_coordinate_text("11°20'32\"N 77°43'41\"E")
        self.assertTrue(res3["found"])
        self.assertAlmostEqual(res3["latitude"], 11.342222, places=5)
        self.assertAlmostEqual(res3["longitude"], 77.728056, places=5)

        # Multi-line DMS
        res4 = parse_coordinate_text("11°20'32.7\"N\n77°43'41.4\"E")
        self.assertTrue(res4["found"])
        self.assertAlmostEqual(res4["latitude"], 11.342417, places=5)
        self.assertAlmostEqual(res4["longitude"], 77.728167, places=5)

        # Prefix format: S 11°20'32.7" W 77°43'41.4"
        res5 = parse_coordinate_text("S 11°20'32.7\" W 77°43'41.4\"")
        self.assertTrue(res5["found"])
        self.assertAlmostEqual(res5["latitude"], -11.342417, places=5)
        self.assertAlmostEqual(res5["longitude"], -77.728167, places=5)

        # Prefix format: N 11°20'32.7" E 77°43'41.4"
        res6 = parse_coordinate_text("N 11°20'32.7\" E 77°43'41.4\"")
        self.assertTrue(res6["found"])
        self.assertAlmostEqual(res6["latitude"], 11.342417, places=5)
        self.assertAlmostEqual(res6["longitude"], 77.728167, places=5)

        # Reversed order: Longitude first (E/W then N/S)
        res7 = parse_coordinate_text("77°43'41.4\"E 11°20'32.7\"N")
        self.assertTrue(res7["found"])
        self.assertAlmostEqual(res7["latitude"], 11.342417, places=5)
        self.assertAlmostEqual(res7["longitude"], 77.728167, places=5)

        # Reversed order prefix: W 77°43'41.4" S 11°20'32.7"
        res8 = parse_coordinate_text("W 77°43'41.4\" S 11°20'32.7\"")
        self.assertTrue(res8["found"])
        self.assertAlmostEqual(res8["latitude"], -11.342417, places=5)
        self.assertAlmostEqual(res8["longitude"], -77.728167, places=5)

        # Multi-line prefix DMS
        res9 = parse_coordinate_text("S 11°20'32.7\"\nW 77°43'41.4\"")
        self.assertTrue(res9["found"])
        self.assertAlmostEqual(res9["latitude"], -11.342417, places=5)
        self.assertAlmostEqual(res9["longitude"], -77.728167, places=5)

    def test_dms_invalid_components_rejected(self):
        """Reject invalid DMS components (minutes/seconds >= 60, degrees > 90/180) rather than normalizing."""
        # Minutes >= 60
        self.assertFalse(parse_coordinate_text("11°60'32.7\"N 77°43'41.4\"E")["found"])
        self.assertFalse(parse_coordinate_text("11°65'32.7\"N 77°43'41.4\"E")["found"])
        self.assertFalse(parse_coordinate_text("11°20'32.7\"N 77°60'41.4\"E")["found"])

        # Seconds >= 60
        self.assertFalse(parse_coordinate_text("11°20'60.0\"N 77°43'41.4\"E")["found"])
        self.assertFalse(parse_coordinate_text("11°20'65.5\"N 77°43'41.4\"E")["found"])
        self.assertFalse(parse_coordinate_text("11°20'32.7\"N 77°43'60.0\"E")["found"])

        # Latitude degrees > 90
        self.assertFalse(parse_coordinate_text("91°20'32.7\"N 77°43'41.4\"E")["found"])
        self.assertFalse(parse_coordinate_text("90°1'0\"N 77°43'41.4\"E")["found"])

        # Longitude degrees > 180
        self.assertFalse(parse_coordinate_text("11°20'32.7\"N 181°43'41.4\"E")["found"])
        self.assertFalse(parse_coordinate_text("11°20'32.7\"N 180°1'0\"E")["found"])

        # Missing hemisphere indicators or incomplete pairs
        self.assertFalse(parse_coordinate_text("11°20'32.7\" 77°43'41.4\"")["found"])
        self.assertFalse(parse_coordinate_text("11°20'32.7\"N")["found"])
        self.assertFalse(parse_coordinate_text("77°43'41.4\"E")["found"])

    # 4. S/W hemisphere signs
    def test_south_west_hemispheres_and_negative_coordinates(self):
        # South and West DMS
        res1 = parse_coordinate_text("11°20'32.7\"S 77°43'41.4\"W")
        self.assertTrue(res1["found"])
        self.assertAlmostEqual(res1["latitude"], -11.342417, places=5)
        self.assertAlmostEqual(res1["longitude"], -77.728167, places=5)

        # South and West decimal
        res2 = parse_coordinate_text("11.342423 S 77.728165 W")
        self.assertTrue(res2["found"])
        self.assertAlmostEqual(res2["latitude"], -11.342423, places=6)
        self.assertAlmostEqual(res2["longitude"], -77.728165, places=6)

        # Explicit minus sign
        res3 = parse_coordinate_text("Lat: -11.3424, Long: -77.7281")
        self.assertTrue(res3["found"])
        self.assertAlmostEqual(res3["latitude"], -11.3424, places=4)
        self.assertAlmostEqual(res3["longitude"], -77.7281, places=4)

        # Both minus and S/W: must remain negative without double negation
        res4 = parse_coordinate_text("Latitude: -11.342423 S, Longitude: -77.728165 W")
        self.assertTrue(res4["found"])
        self.assertAlmostEqual(res4["latitude"], -11.342423, places=6)
        self.assertAlmostEqual(res4["longitude"], -77.728165, places=6)

    # 5. Equator and geographic boundaries
    def test_geographic_boundaries(self):
        # Equator and Prime Meridian (0.0, 0.0)
        res_zero = parse_coordinate_text("Lat: 0.0, Long: 0.0")
        self.assertTrue(res_zero["found"])
        self.assertEqual(res_zero["latitude"], 0.0)
        self.assertEqual(res_zero["longitude"], 0.0)

        # Extreme positive boundaries
        res_max = parse_coordinate_text("Lat: 89.9 N, Long: 179.9 E")
        self.assertTrue(res_max["found"])
        self.assertAlmostEqual(res_max["latitude"], 89.9, places=1)
        self.assertAlmostEqual(res_max["longitude"], 179.9, places=1)

        # Extreme negative boundaries
        res_min = parse_coordinate_text("Lat: -90.0, Long: -180.0")
        self.assertTrue(res_min["found"])
        self.assertEqual(res_min["latitude"], -90.0)
        self.assertEqual(res_min["longitude"], -180.0)

    # 6. Out-of-range and malformed coordinates
    def test_out_of_range_and_malformed(self):
        # Latitude > 90
        res1 = parse_coordinate_text("Lat: 95.0, Long: 77.7281")
        self.assertFalse(res1["found"])
        self.assertIsNone(res1["latitude"])

        # Latitude < -90
        res2 = parse_coordinate_text("Lat: -92.5, Long: 77.7281")
        self.assertFalse(res2["found"])

        # Longitude > 180
        res3 = parse_coordinate_text("Lat: 11.3424, Long: 185.0")
        self.assertFalse(res3["found"])

        # Longitude < -180
        res4 = parse_coordinate_text("Lat: 11.3424, Long: -195.0")
        self.assertFalse(res4["found"])

        # validate_coordinates helper check
        self.assertFalse(validate_coordinates(91.0, 50.0))
        self.assertFalse(validate_coordinates(-91.0, 50.0))
        self.assertFalse(validate_coordinates(10.0, 181.0))
        self.assertFalse(validate_coordinates(10.0, -181.0))
        self.assertFalse(validate_coordinates(None, 50.0))
        self.assertFalse(validate_coordinates(float("nan"), 50.0))
        self.assertFalse(validate_coordinates(float("inf"), 50.0))

    # 7. Dates, timestamps, phone numbers, and unrelated number pairs
    def test_rejection_of_unrelated_numbers(self):
        # Timestamp
        res1 = parse_coordinate_text("2026-10-15 14:30:00")
        self.assertFalse(res1["found"])

        # Date and time
        res2 = parse_coordinate_text("Date: 15/10/2026 Time: 11:20:30 AM")
        self.assertFalse(res2["found"])

        # Phone number
        res3 = parse_coordinate_text("Call us at +91 9876543210")
        self.assertFalse(res3["found"])

        # Speed and camera resolution
        res4 = parse_coordinate_text("Speed: 45 km/h, Resolution: 1920x1080")
        self.assertFalse(res4["found"])

        # Arbitrary numbers without lat/lon labels or hemisphere
        res5 = parse_coordinate_text("Price: 15.50, Weight: 45.20")
        self.assertFalse(res5["found"])

    def test_haversine_distance_calculation(self):
        """Haversine distance calculation must compute true great-circle distance in meters."""
        # Identical points = 0 meters
        self.assertEqual(haversine_distance(11.3424, 77.7281, 11.3424, 77.7281), 0.0)

        # 0.001 deg longitude at Equator ~ 111.19 meters
        dist_eq = haversine_distance(0.0, 0.0, 0.0, 0.001)
        self.assertGreater(dist_eq, 110.0)
        self.assertLess(dist_eq, 112.0)

        # 0.001 deg longitude in Erode (lat ~11.34) ~ 109.02 meters
        dist_erode = haversine_distance(11.3424, 77.7281, 11.3424, 77.7291)
        self.assertGreater(dist_erode, 108.0)
        self.assertLess(dist_erode, 110.0)

        # 0.001 deg longitude in London (lat ~51.5) ~ 69.21 meters (cos(51.5) scaling)
        dist_london = haversine_distance(51.5074, 0.1278, 51.5074, 0.1288)
        self.assertGreater(dist_london, 68.0)
        self.assertLess(dist_london, 71.0)

    # 8. Ambiguous or conflicting candidate pairs
    def test_ambiguous_and_conflicting_candidates(self):
        # Two conflicting coordinate pairs from different locations (> 100m apart)
        conflicting_text = (
            "Lat: 11.3424, Long: 77.7281\n"
            "Lat: 13.0827, Long: 80.2707"
        )
        res = parse_coordinate_text(conflicting_text)
        self.assertFalse(res["found"])
        self.assertIsNone(res["latitude"])
        self.assertIsNone(res["longitude"])
        self.assertIn("Ambiguous coordinates", res["error"])

        # Consistent candidates (< 100m apart, e.g. repeated watermark banner)
        consistent_text = (
            "Lat: 11.342423, Long: 77.728165\n"
            "Lat: 11.342425, Long: 77.728164"
        )
        res_ok = parse_coordinate_text(consistent_text)
        self.assertTrue(res_ok["found"])
        self.assertAlmostEqual(res_ok["latitude"], 11.342423, places=4)

        # High-latitude consistency: Points 50 meters apart at 70° N have delta_lon ~ 0.00131 deg > 0.001 deg.
        # Under true physical Haversine distance (< 100m), they must be recognized as consistent!
        delta_lon_70 = 50.0 / (111320.0 * 0.34202)  # cos(70 deg) ~ 0.34202
        high_lat_text = f"Lat: 70.0000, Long: 10.0000\nLat: 70.0000, Long: {10.0 + delta_lon_70:.5f}"
        res_high_lat = parse_coordinate_text(high_lat_text)
        self.assertTrue(res_high_lat["found"], "Points 50m apart at high latitude must be consistent under Haversine metric")

    # 9. Empty OCR text
    def test_empty_or_whitespace_text(self):
        self.assertFalse(parse_coordinate_text("")["found"])
        self.assertFalse(parse_coordinate_text("   ")["found"])
        self.assertFalse(parse_coordinate_text("\n\t  \n")["found"])
        self.assertFalse(parse_coordinate_text(None)["found"])


class TestOcrEndpoints(unittest.TestCase):
    """Integration tests for OCR API endpoints, security, and error handling."""

    # 10. OCR executable unavailable
    @patch("main.is_tesseract_available", return_value=(False, "Tesseract not installed"))
    def test_ocr_unavailable_returns_safe_response(self, mock_tess):
        """When Tesseract executable is missing, endpoints must return 200 with safe error, NOT HTTP 500."""
        img_bytes = create_synthetic_image(50, 50)
        upload_file = StarletteUploadFile(filename="civic_photo.png", file=io.BytesIO(img_bytes))

        resp = asyncio.run(extract_ocr_upload(upload_file))
        self.assertIsInstance(resp, OcrGpsResponse)
        self.assertFalse(resp.success)
        self.assertFalse(resp.found)
        self.assertIsNone(resp.latitude)
        self.assertIsNone(resp.longitude)
        self.assertIn("Tesseract OCR executable not installed", resp.error)

    # 11. Upload endpoint validation and size restrictions
    def test_upload_corrupt_bytes_rejection(self):
        """Corrupted non-image bytes must raise HTTP 400."""
        corrupt_file = StarletteUploadFile(filename="broken.png", file=io.BytesIO(b"NOT_A_VALID_IMAGE_BYTES"))
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(extract_ocr_upload(corrupt_file))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_upload_oversized_rejection(self):
        """Upload exceeding MAX_IMAGE_BYTES (15MB) must raise HTTP 413."""
        oversized_data = b"x" * (MAX_IMAGE_BYTES + 1024)
        big_file = StarletteUploadFile(filename="huge.png", file=io.BytesIO(oversized_data))
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(extract_ocr_upload(big_file))
        self.assertEqual(ctx.exception.status_code, 413)

    @patch("main.extract_text_from_image")
    def test_upload_endpoint_successful_extraction(self, mock_ocr):
        """Valid upload with mock OCR output must return parsed GPS coordinates."""
        mock_ocr.return_value = (True, "Civic Issue Photo\nLatitude: 11.342423 N, Longitude: 77.728165 E", None)
        img_bytes = create_synthetic_image(64, 64)
        upload_file = StarletteUploadFile(filename="issue.png", file=io.BytesIO(img_bytes))

        resp = asyncio.run(extract_ocr_upload(upload_file))
        self.assertTrue(resp.success)
        self.assertTrue(resp.found)
        self.assertAlmostEqual(resp.latitude, 11.342423, places=6)
        self.assertAlmostEqual(resp.longitude, 77.728165, places=6)
        self.assertEqual(resp.format, "decimal_degrees")
        self.assertIn("Latitude: 11.342423", resp.raw_text)

    # 12. URL endpoint SSRF protections and authentication
    def test_url_endpoint_disallowed_scheme(self):
        """file:// or ftp:// scheme must raise HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            extract_ocr_gps_url(OcrGpsUrlRequest(image_url="file:///etc/passwd"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_url_endpoint_disallowed_domain(self):
        """Non-allowlisted domain must raise HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            extract_ocr_gps_url(OcrGpsUrlRequest(image_url="https://evil.com/fake_gps.png"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_url_endpoint_private_ip_rejection(self):
        """Loopback / private IP must raise HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            extract_ocr_gps_url(OcrGpsUrlRequest(image_url="http://127.0.0.1:8000/test.png"))
        self.assertEqual(ctx.exception.status_code, 400)

    @patch("main.load_image_from_url")
    @patch("main.extract_text_from_image")
    def test_url_endpoint_successful_extraction(self, mock_ocr, mock_load):
        """Valid allowlisted URL must download, extract, and return GPS coordinates."""
        mock_load.return_value = Image.new("RGB", (64, 64), color="blue")
        mock_ocr.return_value = (True, "GPS Map Camera\n11°20'32.7\"N 77°43'41.4\"E", None)

        resp = extract_ocr_gps_url(
            OcrGpsUrlRequest(image_url="https://res.cloudinary.com/demo/image/upload/civic_camera.jpg")
        )
        self.assertTrue(resp.success)
        self.assertTrue(resp.found)
        self.assertAlmostEqual(resp.latitude, 11.342417, places=5)
        self.assertAlmostEqual(resp.longitude, 77.728167, places=5)
        self.assertEqual(resp.format, "degrees_minutes_seconds")

    def test_api_key_protection_on_ocr_endpoints(self):
        """When AI_SERVICE_API_KEY is configured, requests without valid key must receive 401."""
        from main import verify_api_key

        with patch("main.AI_SERVICE_API_KEY", "ocr_test_secret_key"):
            with self.assertRaises(HTTPException) as ctx:
                verify_api_key(x_api_key=None, authorization=None)
            self.assertEqual(ctx.exception.status_code, 401)

            with self.assertRaises(HTTPException) as ctx:
                verify_api_key(x_api_key="invalid_token", authorization=None)
            self.assertEqual(ctx.exception.status_code, 401)

            # Valid key passes
            verify_api_key(x_api_key="ocr_test_secret_key", authorization=None)
            verify_api_key(x_api_key=None, authorization="Bearer ocr_test_secret_key")

    # 13. Existing AI endpoints still work (regression checks)
    def test_health_check_includes_ocr_metadata(self):
        """GET /health must include ocr_available and truthful configuration."""
        data = health_check()
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["live"])
        self.assertIn("ocr_available", data)
        self.assertIn("ocr_engine", data)
        self.assertIn("ocr_version", data)

    def test_readiness_check_intact(self):
        """GET /ready remains functional."""
        data = readiness_check()
        self.assertEqual(data["status"], "ready")
        self.assertTrue(data["ready"])
        self.assertEqual(data["model"], DETERMINISTIC_MODEL_NAME)

    def test_embed_upload_intact(self):
        """POST /embed-upload continues to generate 512-dim embedding."""
        img_bytes = create_synthetic_image(16, 16)
        upload_file = StarletteUploadFile(filename="embed_test.png", file=io.BytesIO(img_bytes))
        resp = asyncio.run(embed_image_upload(upload_file))
        self.assertEqual(resp.dimensions, 512)
        self.assertEqual(len(resp.embedding), 512)

    def test_classify_upload_intact(self):
        """POST /classify-upload continues to return truthful heuristic severity."""
        img_bytes = create_synthetic_image(32, 32)
        upload_file = StarletteUploadFile(filename="classify_test.png", file=io.BytesIO(img_bytes))
        resp = asyncio.run(classify_issue_upload(upload_file, candidate_category="pothole"))
        self.assertEqual(resp.model, "checkpoint_unavailable")
        self.assertGreaterEqual(resp.severity, 1.0)
        self.assertLessEqual(resp.severity, 10.0)

    # 14. Optional real OCR smoke test (only if real tesseract binary is installed)
    @unittest.skipUnless(is_tesseract_available()[0], "Tesseract executable not installed locally on host")
    def test_optional_real_tesseract_smoke_test(self):
        """Optional smoke test executing real Tesseract OCR on a synthetic drawn image."""
        img = Image.new("RGB", (400, 100), color="white")
        draw = ImageDraw.Draw(img)
        draw.text((10, 30), "Lat: 11.3424, Long: 77.7281", fill="black")

        ok, raw_text, err = extract_text_from_image(img)
        self.assertTrue(ok)
        self.assertIsNotNone(raw_text)
        parsed = parse_coordinate_text(raw_text)
        self.assertTrue(parsed["found"])
        self.assertAlmostEqual(parsed["latitude"], 11.3424, places=2)
        self.assertAlmostEqual(parsed["longitude"], 77.7281, places=2)


if __name__ == "__main__":
    unittest.main()
