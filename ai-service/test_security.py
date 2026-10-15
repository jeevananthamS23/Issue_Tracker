"""
CivicVision AI — Security & Remediation Unit Tests for AI Microservice (Phase 3.3.1)

Tests:
1. URL scheme validation (HTTP/HTTPS only; reject file://, ftp://, gopher://)
2. Domain allowlisting (Permit Cloudinary, reject evil.com, attacker.com)
3. IP & SSRF defenses (Reject 127.0.0.1, 10.0.0.1, 192.168.1.1, 169.254.169.254, ::1)
4. Redirect blocking (Strictly reject 301/302 redirects)
5. Size limit & streaming (Reject payloads exceeding 15MB)
6. Image validation (Reject corrupt bytes, unsupported formats)
7. Decompression bomb protection (Enforce pixel limits)
8. Truthful model metadata ("deterministic_engine_v1" when online model is not loaded)
"""

import io
import unittest
from unittest.mock import patch, MagicMock
from PIL import Image
from fastapi import HTTPException
from main import (
    is_host_allowed,
    is_ip_safe,
    validate_image_url,
    load_image_from_bytes,
    load_image_from_url,
    get_active_model_info,
    sanitize_url,
    cosine_similarity,
    DETERMINISTIC_MODEL_NAME,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_PIXELS
)


class TestAiServiceSecurity(unittest.TestCase):

    def test_url_sanitization(self):
        """Query parameters, tokens, and credentials must be stripped from URLs before logging."""
        dirty = "https://res.cloudinary.com/demo/image/upload/sample.jpg?api_key=SECRET123&sig=abcd#frag"
        clean = sanitize_url(dirty)
        self.assertEqual(clean, "https://res.cloudinary.com/demo/image/upload/sample.jpg")
        self.assertNotIn("SECRET123", clean)
        self.assertNotIn("abcd", clean)

    def test_domain_allowlist(self):
        """Only explicitly allowlisted domains (Cloudinary) must be permitted."""
        self.assertTrue(is_host_allowed("res.cloudinary.com"))
        self.assertTrue(is_host_allowed("subdomain.cloudinary.com"))
        self.assertTrue(is_host_allowed("cloudinary.com"))
        self.assertFalse(is_host_allowed("evil.com"))
        self.assertFalse(is_host_allowed("cloudinary.com.attacker.com"))
        self.assertFalse(is_host_allowed("localhost"))
        self.assertFalse(is_host_allowed("127.0.0.1"))
        self.assertFalse(is_host_allowed("169.254.169.254"))

    def test_ip_safety_validation(self):
        """Private, loopback, link-local, and cloud metadata IPs must be rejected."""
        # Loopback
        safe, reason = is_ip_safe("127.0.0.1")
        self.assertFalse(safe)
        self.assertIn("Loopback", reason)

        safe, _ = is_ip_safe("::1")
        self.assertFalse(safe)

        # Cloud metadata (AWS, GCP, Azure, OpenStack)
        safe, reason = is_ip_safe("169.254.169.254")
        self.assertFalse(safe)
        self.assertIn("metadata", reason.lower())

        # Private RFC 1918
        self.assertFalse(is_ip_safe("10.0.0.5")[0])
        self.assertFalse(is_ip_safe("172.16.0.1")[0])
        self.assertFalse(is_ip_safe("192.168.1.100")[0])

        # Public IP should pass
        safe, _ = is_ip_safe("8.8.8.8")
        self.assertTrue(safe)

    def test_url_scheme_validation(self):
        """Disallowed schemes like file:// or ftp:// must raise HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            validate_image_url("file:///etc/passwd")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("scheme", ctx.exception.detail.lower())

        with self.assertRaises(HTTPException) as ctx:
            validate_image_url("ftp://res.cloudinary.com/image.jpg")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_disallowed_host_rejection(self):
        """Non-allowlisted hosts must raise HTTP 400."""
        with self.assertRaises(HTTPException) as ctx:
            validate_image_url("http://169.254.169.254/latest/meta-data/")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("allowlist", ctx.exception.detail.lower())

        with self.assertRaises(HTTPException) as ctx:
            validate_image_url("https://attacker-controlled-server.com/test.jpg")
        self.assertEqual(ctx.exception.status_code, 400)

    @patch("main.requests.get")
    def test_redirect_rejection(self, mock_get):
        """Redirects (301/302) must be strictly rejected to prevent SSRF bypasses."""
        mock_response = MagicMock()
        mock_response.status_code = 302
        mock_response.headers = {"Location": "http://169.254.169.254"}
        mock_get.return_value = mock_response

        with patch("main.validate_image_url") as mock_val:
            mock_val.return_value = MagicMock()
            with self.assertRaises(HTTPException) as ctx:
                load_image_from_url("https://res.cloudinary.com/demo/image/upload/sample.jpg")
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("redirect", ctx.exception.detail.lower())

    @patch("main.requests.get")
    def test_oversized_image_rejection(self, mock_get):
        """Responses exceeding MAX_IMAGE_BYTES (15MB) must raise HTTP 413."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.headers = {"Content-Length": str(MAX_IMAGE_BYTES + 1000)}
        mock_get.return_value = mock_response

        with patch("main.validate_image_url") as mock_val:
            mock_val.return_value = MagicMock()
            with self.assertRaises(HTTPException) as ctx:
                load_image_from_url("https://res.cloudinary.com/demo/image/upload/huge.jpg")
            self.assertEqual(ctx.exception.status_code, 413)

    def test_corrupt_image_bytes(self):
        """Corrupt or non-image bytes must raise HTTP 400."""
        corrupt_data = b"NOT_AN_IMAGE_FILE_AT_ALL_JUST_RANDOM_TEXT"
        with self.assertRaises(HTTPException) as ctx:
            load_image_from_bytes(corrupt_data)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_valid_image_bytes_supported_formats(self):
        """Valid JPEG, PNG, and WebP images must load cleanly."""
        # Create a small 10x10 PNG in memory
        img = Image.new("RGB", (10, 10), color="blue")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_bytes = buf.getvalue()

        loaded = load_image_from_bytes(png_bytes)
        self.assertEqual(loaded.size, (10, 10))

    def test_decompression_bomb_rejection(self):
        """Images exceeding MAX_IMAGE_PIXELS must be rejected."""
        # Create an image that reports dimensions exceeding 25 million pixels
        fake_data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
        with patch("main.Image.open") as mock_open:
            mock_img = MagicMock()
            mock_img.format = "PNG"
            mock_img.width = 6000
            mock_img.height = 5000  # 30 million pixels > 25M
            mock_open.return_value = mock_img

            with self.assertRaises(HTTPException) as ctx:
                load_image_from_bytes(b"dummy_bytes_long_enough_1234567890")
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("pixel limit", ctx.exception.detail.lower())

    def test_truthful_model_metadata(self):
        """When live CLIP weights are not loaded, truthful model name must be deterministic_engine_v1."""
        info = get_active_model_info()
        self.assertEqual(info["model_name"], DETERMINISTIC_MODEL_NAME)
        self.assertEqual(info["mode"], "deterministic_engine")

    def test_health_liveness_endpoint(self):
        """GET /health must return live=True and report truthful model and configuration."""
        from main import health_check
        data = health_check()
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["live"])
        self.assertEqual(data["model"], DETERMINISTIC_MODEL_NAME)
        self.assertEqual(data["mode"], "deterministic_engine")

    def test_ready_endpoint_deterministic(self):
        """GET /ready under deterministic mode must return ready=True with status 200."""
        from main import readiness_check
        data = readiness_check()
        self.assertEqual(data["status"], "ready")
        self.assertTrue(data["ready"])
        self.assertEqual(data["model"], DETERMINISTIC_MODEL_NAME)

    def test_ready_endpoint_online_model_failure(self):
        """GET /ready must return 503 if USE_ONLINE_MODEL=true but model weights fail to load."""
        import main
        from main import readiness_check

        with patch.dict(main.os.environ, {"USE_ONLINE_MODEL": "true"}):
            with patch("main.get_clip_components", return_value=(None, None)):
                with patch("main._model_load_error", "Mock HuggingFace weights download timeout"):
                    with self.assertRaises(HTTPException) as ctx:
                        readiness_check()
                    self.assertEqual(ctx.exception.status_code, 503)
                    detail = ctx.exception.detail
                    self.assertEqual(detail["status"], "not_ready")
                    self.assertFalse(detail["ready"])

    def test_api_key_protection_enforcement(self):
        """When AI_SERVICE_API_KEY is configured, requests without valid key must receive 401."""
        from main import verify_api_key

        with patch("main.AI_SERVICE_API_KEY", "super_secret_test_key_123"):
            # Request without key -> 401
            with self.assertRaises(HTTPException) as ctx:
                verify_api_key(x_api_key=None, authorization=None)
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertIn("API key", ctx.exception.detail)

            # Request with wrong key -> 401
            with self.assertRaises(HTTPException) as ctx:
                verify_api_key(x_api_key="wrong_key", authorization=None)
            self.assertEqual(ctx.exception.status_code, 401)

            # Request with correct X-API-Key -> passes without exception
            verify_api_key(x_api_key="super_secret_test_key_123", authorization=None)

            # Request with correct Bearer token -> passes without exception
            verify_api_key(x_api_key=None, authorization="Bearer super_secret_test_key_123")

    def test_multipart_upload_file_endpoint(self):
        """POST /embed-upload with multipart/form-data must process valid image upload."""
        import asyncio
        from starlette.datastructures import UploadFile as StarletteUploadFile
        from main import embed_image_upload

        # Create valid 10x10 PNG bytes
        img = Image.new("RGB", (10, 10), color="green")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_bytes = buf.getvalue()

        upload_file = StarletteUploadFile(filename="test.png", file=io.BytesIO(png_bytes))

        resp = asyncio.run(embed_image_upload(upload_file))
        self.assertEqual(resp.dimensions, 512)
        self.assertEqual(len(resp.embedding), 512)
        self.assertEqual(resp.model, DETERMINISTIC_MODEL_NAME)
        self.assertFalse(resp.cached)


if __name__ == "__main__":
    unittest.main()
