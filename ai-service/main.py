"""
CivicVision AI — Hardened CLIP Inference Microservice (Phase 3.3.2)

Provides:
- 512-dimensional CLIP image embeddings (openai/clip-vit-base-patch32)
- Offline deterministic fallback encoder with truthful model identification ("deterministic_engine_v1")
- Cosine similarity computation for Stage 2 duplicate detection
- Startup lifespan handler to pre-warm model once per process
- Explicit liveness (/health) and readiness (/ready) endpoints
- Configurable optional API key authorization (X-API-Key / Bearer)
- Dynamic host/port binding (supports cloud deployment platforms e.g. Render)
- Defense-in-depth SSRF protection:
  * Strict HTTP/HTTPS scheme enforcement
  * Configurable domain allowlist (Cloudinary domains by default)
  * DNS resolution and private/loopback/link-local/metadata IP rejection
  * Strict redirect blocking (allow_redirects=False)
  * Streaming download with 15MB size limit
  * Pillow decompression-bomb protections and pixel/dimension caps
  * Redacted URL logging (sanitized query strings and secrets)
- In-memory LRU embedding cache for candidate images
"""

import os
import io
import re
import math
import socket
import ipaddress
import urllib.parse
import logging
import subprocess
import requests
from contextlib import asynccontextmanager
from typing import List, Optional, Tuple, Dict, Any
from pydantic import BaseModel, Field
from fastapi import FastAPI, HTTPException, UploadFile, File, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import pytesseract

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("civicvision.ai")

MODEL_NAME = os.getenv("CLIP_MODEL_NAME", "openai/clip-vit-base-patch32")
DETERMINISTIC_MODEL_NAME = "deterministic_engine_v1"
DEVICE = "cpu"
EMBEDDING_DIM = 512
MAX_CACHE_SIZE = 500

# Security and authorization
AI_SERVICE_API_KEY = os.getenv("AI_SERVICE_API_KEY", "").strip()

# Resource limits
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", 15 * 1024 * 1024))  # 15 MB
MAX_IMAGE_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", 25_000_000))       # 25 Megapixels
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

# Tesseract OCR Configuration (Phase F5-B / Feature F5)
# Local development:
# Windows: Install from UB-Mannheim/tesseract/wiki and set TESSERACT_CMD if not in PATH:
#   e.g. TESSERACT_CMD="C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
# Linux / Ubuntu / Debian: sudo apt-get update && sudo apt-get install -y tesseract-ocr
# macOS: brew install tesseract
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "").strip()
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
OCR_TIMEOUT_SECONDS = float(os.getenv("OCR_TIMEOUT_SECONDS", "5.0"))

# Domain allowlist: Defaults to Cloudinary domains used by the application.
DEFAULT_ALLOWED_HOSTS = "res.cloudinary.com,*.cloudinary.com,cloudinary.com"
ALLOWED_HOSTS_RAW = os.getenv("ALLOWED_IMAGE_HOSTS", DEFAULT_ALLOWED_HOSTS)
ALLOWED_HOSTS = [h.strip().lower() for h in ALLOWED_HOSTS_RAW.split(",") if h.strip()]

# In-memory LRU cache for image URL embeddings
EMBEDDING_CACHE = {}

# Lazy-loaded model references
_clip_model = None
_clip_processor = None
_model_load_attempted = False
_model_load_error = None

# Civic classification model constants & references (Phase 4.1B & Phase 1)
DEFAULT_CIVIC_MODEL_PATH = os.path.join(
    os.path.dirname(__file__),
    "checkpoints",
    "phase1_road_classifier",
    "run_20261027_pretrained_bs8_e10",
    "best_model.pt"
)
CIVIC_MODEL_PATH = os.getenv("CIVIC_MODEL_PATH", "").strip()
ROAD_CLASSIFIER_THRESHOLDS = {
    "pothole": 0.75,
    "road_damage": 0.35
}
ROAD_CLASSIFIER_LABELS = ["pothole", "road_damage"]
CIVIC_CATEGORIES = [
    "pothole",
    "road_damage",
    "garbage",
    "street_light",
    "water_leak",
    "sewage",
    "traffic_signal",
    "other"
]

CANONICAL_DEPARTMENT_MAP = {
    "pothole": "Roads & Infrastructure",
    "road_damage": "Roads & Infrastructure",
    "garbage": "Waste Management",
    "street_light": "Street Lighting",
    "water_leak": "Water Services",
    "sewage": "Water Services",
    "traffic_signal": "Public Works",
    "other": "Public Works"
}

# Base hazard scores for heuristic severity baseline (Research Paper Section VI-B)
BASE_HAZARD_SCORES = {
    "traffic_signal": 7.0,
    "sewage": 6.5,
    "pothole": 5.0,
    "road_damage": 5.0,
    "water_leak": 4.5,
    "street_light": 4.0,
    "garbage": 3.5,
    "other": 3.0
}

_civic_model = None
_civic_model_metadata = None
_civic_model_attempted = False
_civic_model_error = None


def get_civic_classifier(model_path: Optional[str] = None, force_reload: bool = False):
    """
    Attempts to load a genuinely trained civic defect classification model if configured.
    Strict truthfulness: If CIVIC_MODEL_PATH is unset or invalid, returns None.
    When configured, instantiates MobileNetV3-Small and loads checkpoint weights and metadata.
    """
    global _civic_model, _civic_model_metadata, _civic_model_attempted, _civic_model_error
    if _civic_model_attempted and not force_reload:
        return _civic_model

    target_path = model_path if model_path is not None else CIVIC_MODEL_PATH
    target_path = (target_path or "").strip()

    _civic_model_attempted = True
    if not target_path or not os.path.exists(target_path):
        _civic_model_error = f"No trained civic classification checkpoint configured or found at '{target_path}'"
        _civic_model = None
        _civic_model_metadata = None
        return None

    try:
        import torch
        from scripts.train_road_classifier import build_mobilenetv3_road_classifier, get_transforms

        logger.info(f"Loading trained civic classification checkpoint from {target_path}...")
        checkpoint = torch.load(target_path, map_location=DEVICE)

        model = build_mobilenetv3_road_classifier(num_classes=2, pretrained=False)
        model.load_state_dict(checkpoint["model_state_dict"])
        model.to(DEVICE)
        model.eval()

        val_metrics = checkpoint.get("val_metrics", {})
        classes_meta = val_metrics.get("classes", {})
        thresholds = {
            "pothole": float(classes_meta.get("pothole", {}).get("threshold", ROAD_CLASSIFIER_THRESHOLDS["pothole"])),
            "road_damage": float(classes_meta.get("road_damage", {}).get("threshold", ROAD_CLASSIFIER_THRESHOLDS["road_damage"]))
        }

        metadata = {
            "model_name": "MobileNetV3-Small",
            "version": "MobileNetV3-Small_phase1_road_epoch8",
            "thresholds": thresholds,
            "labels": ROAD_CLASSIFIER_LABELS,
            "transform": get_transforms(split="val", image_size=224),
            "checkpoint_path": target_path
        }
        model.metadata = metadata

        _civic_model = model
        _civic_model_metadata = metadata
        _civic_model_error = None
        logger.info(f"Civic road classification model loaded successfully. Thresholds: {thresholds}")
    except Exception as e:
        _civic_model_error = str(e)
        logger.warning(f"Failed to load civic checkpoint ({e}). Model unavailable.")
        _civic_model = None
        _civic_model_metadata = None

    return _civic_model


def compute_heuristic_severity(image: Image.Image, candidate_category: Optional[str] = None) -> Tuple[Optional[float], Optional[str]]:
    """
    Rule-based heuristic severity baseline (Phase 4.1B).
    
    Formula:
      S_raw = B_cat + 3.0 * norm_edge
      S = round(clamp(S_raw, 1.0, 10.0), 1)
      
    Features:
    1. B_cat: Category base hazard rating in [3.0, 7.0]. Defaults to 3.0 for unknown/other.
    2. norm_edge: Average adjacent pixel intensity difference on 128x128 grayscale,
       normalized to [0.0, 1.0] (saturation at delta >= 40.0).
       
    Strict bounds: Always within [1.0, 10.0].
    Returns (None, None) if image features cannot be calculated.
    Note: Heuristic baseline for operational prioritization; not clinically or physically validated.
    """
    if image is None:
        return None, None

    try:
        # 1. Base hazard
        norm_cat = (candidate_category or "").strip().lower().replace("-", "_").replace(" ", "_")
        b_cat = BASE_HAZARD_SCORES.get(norm_cat, BASE_HAZARD_SCORES["other"])

        # 2. Edge / contrast energy feature
        gray = image.convert("L").resize((128, 128))
        if hasattr(gray, "get_flattened_data"):
            raw_pixels = list(gray.get_flattened_data())
        else:
            raw_pixels = list(gray.getdata())

        if not raw_pixels or len(raw_pixels) != 128 * 128:
            return None, None

        diff_sum = 0
        count = 0
        for y in range(128):
            row_offset = y * 128
            for x in range(127):
                diff_sum += abs(raw_pixels[row_offset + x + 1] - raw_pixels[row_offset + x])
                count += 1

        avg_diff = diff_sum / count if count > 0 else 0.0
        norm_edge = min(1.0, avg_diff / 40.0)

        s_raw = b_cat + (3.0 * norm_edge)
        s_clamped = round(max(1.0, min(10.0, s_raw)), 1)
        return s_clamped, "rule_based_heuristic"
    except Exception as e:
        logger.warning(f"Error computing heuristic severity: {e}")
        return None, None


def classify_road_defect_image(image: Image.Image, candidate_category: Optional[str] = None) -> Dict[str, Any]:
    """
    Executes inference using the trained MobileNetV3-Small road defect classifier.
    Truthfulness guarantees:
    - If no checkpoint is configured or found, reports mode='checkpoint_unavailable',
      category=None, confidence=None, is_trained_model=False, and returns heuristic severity.
    - If checkpoint is loaded, evaluates multi-label probabilities against validation-calibrated
      thresholds (pothole >= 0.75, road_damage >= 0.35).
    - If inference fails with an exception, returns status='error' with sanitized error details,
      preserving heuristic severity so the submission pipeline can continue safely.
    """
    if image is None:
        return {
            "category": None,
            "confidence": None,
            "severity": None,
            "suggested_department": None,
            "model": "none",
            "mode": "invalid_input",
            "is_trained_model": False,
            "severity_mode": None,
            "status": "error",
            "detected_classes": [],
            "probabilities": {},
            "thresholds": ROAD_CLASSIFIER_THRESHOLDS,
            "model_version": None,
            "error": "Image is null or invalid"
        }

    model = get_civic_classifier()
    if model is None:
        sev_val, sev_mode = compute_heuristic_severity(image, candidate_category)
        return {
            "category": None,
            "confidence": None,
            "severity": sev_val,
            "suggested_department": None,
            "model": "checkpoint_unavailable",
            "mode": "checkpoint_unavailable",
            "is_trained_model": False,
            "severity_mode": sev_mode,
            "status": "unavailable",
            "detected_classes": [],
            "probabilities": {},
            "thresholds": ROAD_CLASSIFIER_THRESHOLDS,
            "model_version": None,
            "error": _civic_model_error or "No trained civic classification checkpoint configured or found"
        }

    metadata = getattr(model, "metadata", {})
    try:
        import torch
        transform = metadata.get("transform")
        if transform is None:
            from scripts.train_road_classifier import get_transforms
            transform = get_transforms(split="val", image_size=224)

        img_rgb = image.convert("RGB")
        tensor = transform(img_rgb).unsqueeze(0).to(DEVICE)

        with torch.no_grad():
            logits = model(tensor)
            probs = torch.sigmoid(logits)[0]

        prob_pothole = float(probs[0].item())
        prob_road_damage = float(probs[1].item())
        probabilities = {
            "pothole": round(prob_pothole, 4),
            "road_damage": round(prob_road_damage, 4)
        }

        th = metadata.get("thresholds", ROAD_CLASSIFIER_THRESHOLDS)
        is_pothole = prob_pothole >= th["pothole"]
        is_road_damage = prob_road_damage >= th["road_damage"]

        detected = []
        if is_pothole:
            detected.append("pothole")
        if is_road_damage:
            detected.append("road_damage")

        if is_pothole:
            pred_category = "pothole"
            confidence = round(prob_pothole, 4)
        elif is_road_damage:
            pred_category = "road_damage"
            confidence = round(prob_road_damage, 4)
        else:
            pred_category = None
            confidence = round(max(prob_pothole, prob_road_damage), 4)

        dept = CANONICAL_DEPARTMENT_MAP.get(pred_category, "Roads & Infrastructure" if pred_category else None)
        sev_val, sev_mode = compute_heuristic_severity(image, pred_category or candidate_category)

        return {
            "category": pred_category,
            "confidence": confidence,
            "severity": sev_val,
            "suggested_department": dept,
            "model": metadata.get("version", "MobileNetV3-Small_phase1_road"),
            "mode": "trained_checkpoint",
            "is_trained_model": True,
            "severity_mode": sev_mode,
            "status": "classified" if pred_category else "unverified",
            "detected_classes": detected,
            "probabilities": probabilities,
            "thresholds": th,
            "model_version": metadata.get("version", "MobileNetV3-Small_phase1_road_epoch8"),
            "error": None
        }
    except Exception as e:
        logger.error(f"Inference execution failed on image: {e}")
        sev_val, sev_mode = compute_heuristic_severity(image, candidate_category)
        return {
            "category": None,
            "confidence": None,
            "severity": sev_val,
            "suggested_department": None,
            "model": metadata.get("version", "MobileNetV3-Small_phase1_road"),
            "mode": "inference_error",
            "is_trained_model": True,
            "severity_mode": sev_mode,
            "status": "error",
            "detected_classes": [],
            "probabilities": {},
            "thresholds": metadata.get("thresholds", ROAD_CLASSIFIER_THRESHOLDS),
            "model_version": metadata.get("version"),
            "error": str(e)
        }



def get_clip_components():
    """Lazily load the HuggingFace CLIP model and processor on CPU if online mode is enabled."""
    global _clip_model, _clip_processor, _model_load_attempted, _model_load_error
    if _model_load_attempted:
        return _clip_model, _clip_processor

    _model_load_attempted = True
    # Default to deterministic engine to ensure fast, isolated, and reproducible execution
    if os.getenv("USE_ONLINE_MODEL", "false").lower() != "true":
        return None, None

    try:
        from transformers import CLIPProcessor, CLIPModel
        logger.info(f"Loading CLIP model {MODEL_NAME} on {DEVICE}...")
        _clip_processor = CLIPProcessor.from_pretrained(MODEL_NAME)
        _clip_model = CLIPModel.from_pretrained(MODEL_NAME).to(DEVICE)
        _clip_model.eval()
        _model_load_error = None
        logger.info("CLIP model loaded successfully.")
    except Exception as e:
        _model_load_error = str(e)
        logger.warning(f"Transformers CLIP load deferred or failed ({e}). Fallback deterministic encoder active.")
        _clip_model = None
        _clip_processor = None

    return _clip_model, _clip_processor


def is_model_ready() -> Tuple[bool, str, Optional[str]]:
    """Evaluates whether the service is ready for inference under current configuration."""
    use_online = os.getenv("USE_ONLINE_MODEL", "false").lower() == "true"
    if not use_online:
        return True, DETERMINISTIC_MODEL_NAME, None

    model, processor = get_clip_components()
    if model is not None and processor is not None:
        return True, MODEL_NAME, None

    raw_err = _model_load_error or "Model weights not loaded"
    sanitized_err = raw_err.split("\n")[0][:200]
    return False, "none", sanitized_err


def get_active_model_info():
    """Returns truthful model name and mode based on actual runtime component availability."""
    model, processor = get_clip_components()
    if model is not None and processor is not None:
        return {
            "model_name": MODEL_NAME,
            "mode": "live_clip"
        }
    return {
        "model_name": DETERMINISTIC_MODEL_NAME,
        "mode": "deterministic_engine"
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan context manager: pre-warms model once at startup if online mode is requested."""
    if os.getenv("USE_ONLINE_MODEL", "false").lower() == "true":
        logger.info("Lifespan startup: Pre-warming configured CLIP model components...")
        get_clip_components()
    yield
    logger.info("Lifespan shutdown: Cleaning up resources.")


app = FastAPI(
    title="CivicVision AI CLIP Inference Service",
    version="1.2.0",
    description="Hardened microservice providing CLIP image embeddings and similarity comparisons for civic issue reporting.",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_api_key(
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    authorization: Optional[str] = Header(None)
):
    """
    Validates optional API key for deployed environments.
    If AI_SERVICE_API_KEY is unset, all requests are permitted (local/test mode).
    If set, requests must provide either X-API-Key or Bearer token.
    """
    if not AI_SERVICE_API_KEY:
        return

    provided = None
    if x_api_key:
        provided = x_api_key.strip()
    elif authorization and authorization.lower().startswith("bearer "):
        provided = authorization[7:].strip()

    if not provided or provided != AI_SERVICE_API_KEY:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: Invalid or missing AI service API key."
        )


def sanitize_url(url: str) -> str:
    """Sanitizes URL for safe logging by removing query parameters and credentials."""
    try:
        parsed = urllib.parse.urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    except Exception:
        return "[unparseable_url]"


def is_host_allowed(host: str) -> bool:
    """Matches host against configured domain allowlist (supports *.domain.com wildcard)."""
    if not host:
        return False
    host_lower = host.lower()
    for pattern in ALLOWED_HOSTS:
        if pattern.startswith("*."):
            base_domain = pattern[2:]
            if host_lower == base_domain or host_lower.endswith("." + base_domain):
                return True
        elif host_lower == pattern:
            return True
    return False


def is_ip_safe(ip_str: str) -> Tuple[bool, str]:
    """Validates that an IP address is not private, loopback, link-local, reserved, or cloud metadata."""
    try:
        ip = ipaddress.ip_address(ip_str)
        # Explicit block for cloud instance metadata endpoints (AWS, GCP, Azure, OpenStack)
        if str(ip) == "169.254.169.254":
            return False, "Cloud instance metadata IP (169.254.169.254) rejected"
        if ip.is_loopback:
            return False, f"Loopback address rejected: {ip_str}"
        if ip.is_link_local:
            return False, f"Link-local address rejected: {ip_str}"
        if ip.is_private:
            return False, f"Private/RFC1918 address rejected: {ip_str}"
        if ip.is_multicast:
            return False, f"Multicast address rejected: {ip_str}"
        if ip.is_reserved:
            return False, f"Reserved address rejected: {ip_str}"
        if ip.is_unspecified:
            return False, f"Unspecified address rejected: {ip_str}"
        return True, "OK"
    except ValueError:
        return False, f"Invalid IP address format: {ip_str}"


def validate_image_url(url: str) -> urllib.parse.ParseResult:
    """
    Validates URL scheme, domain allowlist, and destination IP to prevent SSRF.
    Enforces that the host is allowlisted AND resolves exclusively to non-internal public IPs.
    """
    if not url or not isinstance(url, str):
        raise HTTPException(status_code=400, detail="Image URL must be a non-empty string.")

    try:
        parsed = urllib.parse.urlparse(url.strip())
    except Exception:
        raise HTTPException(status_code=400, detail="Malformed URL structure.")

    # 1. Scheme validation: HTTP and HTTPS only
    if parsed.scheme.lower() not in ("http", "https"):
        raise HTTPException(
            status_code=400,
            detail=f"Disallowed URL scheme '{parsed.scheme}'. Only HTTP and HTTPS are permitted."
        )

    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="URL is missing a valid hostname.")

    # 2. Domain allowlist validation
    if not is_host_allowed(hostname):
        raise HTTPException(
            status_code=400,
            detail=f"Host '{hostname}' is not in the trusted domain allowlist."
        )

    # 3. DNS resolution & IP safety check
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        addr_info = socket.getaddrinfo(hostname, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise HTTPException(status_code=400, detail=f"Failed to resolve host '{hostname}': {str(e)}")

    if not addr_info:
        raise HTTPException(status_code=400, detail=f"No IP addresses resolved for host '{hostname}'.")

    for entry in addr_info:
        resolved_ip = entry[4][0]
        safe, reason = is_ip_safe(resolved_ip)
        if not safe:
            logger.warning(f"SSRF attempt blocked for host '{hostname}' (resolved to {resolved_ip}): {reason}")
            raise HTTPException(
                status_code=400,
                detail=f"Destination address for '{hostname}' resolved to prohibited IP ({reason})."
            )

    return parsed


def generate_deterministic_embedding(image: Image.Image) -> List[float]:
    """
    Generates a deterministic, L2-normalized 512-dimensional unit vector from an image.
    Used for offline testing, CI environments, and graceful fallback when heavy model weights are unavailable.
    """
    img = image.convert("RGB").resize((64, 64))
    pixels = list(img.getdata())

    # Generate 512 pseudo-features using spatial bins and RGB hashing
    raw_vector = [0.0] * EMBEDDING_DIM
    for idx, (r, g, b) in enumerate(pixels):
        bin_idx = (idx * 7 + r * 3 + g * 5 + b) % EMBEDDING_DIM
        lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
        raw_vector[bin_idx] += lum

    # Compute L2 norm
    norm = math.sqrt(sum(v * v for v in raw_vector))
    if norm == 0.0:
        raw_vector[0] = 1.0
        norm = 1.0

    return [round(v / norm, 6) for v in raw_vector]


def compute_clip_embedding(image: Image.Image) -> Tuple[List[float], str]:
    """
    Generates an L2-normalized 512-dim embedding using either live CLIP or deterministic fallback.
    Returns tuple: (embedding, model_name).
    """
    model, processor = get_clip_components()

    if model is not None and processor is not None:
        import torch
        with torch.no_grad():
            inputs = processor(images=image, return_tensors="pt").to(DEVICE)
            image_features = model.get_image_features(**inputs)
            normalized = image_features / image_features.norm(dim=-1, keepdim=True)
            return [round(float(val), 6) for val in normalized[0].tolist()], MODEL_NAME

    return generate_deterministic_embedding(image), DETERMINISTIC_MODEL_NAME


def load_image_from_bytes(data: bytes) -> Image.Image:
    """Validates and opens an image from raw bytes with format and decompression bomb protections."""
    if not data or len(data) < 12:
        raise HTTPException(status_code=400, detail="Empty or corrupted image data.")

    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Image size ({len(data)} bytes) exceeds maximum limit of {MAX_IMAGE_BYTES} bytes."
        )

    try:
        img_stream = io.BytesIO(data)
        img = Image.open(img_stream)
        img.verify()

        # Re-open for actual processing (verify() clears buffer state)
        img_stream.seek(0)
        img = Image.open(img_stream)

        # Whitelist allowed formats
        allowed_formats = ("JPEG", "PNG", "WEBP")
        if (img.format or "").upper() not in allowed_formats:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported image format '{img.format}'. Allowed formats: {', '.join(allowed_formats)}."
            )

        # Check total pixel count to defend against decompression bombs
        pixel_count = img.width * img.height
        if pixel_count > MAX_IMAGE_PIXELS:
            raise HTTPException(
                status_code=400,
                detail=f"Image dimensions ({img.width}x{img.height} = {pixel_count} px) exceed maximum pixel limit of {MAX_IMAGE_PIXELS}."
            )

        return img
    except Image.DecompressionBombError:
        raise HTTPException(status_code=400, detail="Image exceeds decompression bomb threshold.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image format: {str(e)}")


def load_image_from_url(url: str, connect_timeout: float = 3.0, read_timeout: float = 5.0) -> Image.Image:
    """
    Safely downloads and decodes an image from a URL with full defense-in-depth protections:
    - URL structure & scheme validation (HTTP/HTTPS only)
    - Domain allowlisting
    - DNS resolution & private/loopback/link-local/metadata IP rejection
    - Prohibition of automatic redirects (allow_redirects=False)
    - Streaming download with maximum response size limit (15MB)
    - Format and decompression bomb checks
    """
    validate_image_url(url)
    safe_url = sanitize_url(url)

    try:
        response = requests.get(
            url,
            timeout=(connect_timeout, read_timeout),
            stream=True,
            allow_redirects=False,
            headers={"User-Agent": "CivicVisionAI/1.0"}
        )

        # Disallow redirects to prevent open-redirect SSRF bypasses
        if response.status_code in (301, 302, 303, 307, 308):
            raise HTTPException(
                status_code=400,
                detail="Redirects are disallowed for image retrieval to prevent SSRF vulnerabilities."
            )

        if response.status_code != 200:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to download image from URL (HTTP {response.status_code})."
            )

        # Enforce Content-Length header limit if present
        content_length = response.headers.get("Content-Length")
        if content_length and content_length.isdigit() and int(content_length) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Image size ({content_length} bytes) exceeds maximum allowable limit of {MAX_IMAGE_BYTES} bytes."
            )

        # Stream download with running byte counter
        buffer = bytearray()
        for chunk in response.iter_content(chunk_size=65536):
            buffer.extend(chunk)
            if len(buffer) > MAX_IMAGE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Image download exceeded maximum size limit of {MAX_IMAGE_BYTES} bytes."
                )

        return load_image_from_bytes(bytes(buffer))

    except HTTPException:
        raise
    except requests.Timeout:
        logger.warning(f"Image download timed out for {safe_url}")
        raise HTTPException(status_code=504, detail="Image download timed out.")
    except requests.RequestException as e:
        logger.warning(f"Image download error for {safe_url}: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Image download error: {str(e)}")


def cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    """Calculates cosine similarity between two float vectors with dimension, finite, and zero-norm checks."""
    if not vec_a or not vec_b or len(vec_a) != len(vec_b):
        return 0.0

    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0

    for a, b in zip(vec_a, vec_b):
        if not math.isfinite(a) or not math.isfinite(b):
            return 0.0
        dot += a * b
        norm_a += a * a
        norm_b += b * b

    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0

    sim = dot / (math.sqrt(norm_a) * math.sqrt(norm_b))
    return round(max(-1.0, min(1.0, sim)), 4)


# Request & Response Models
class EmbedUrlRequest(BaseModel):
    image_url: str = Field(..., description="Public HTTP/HTTPS URL of the issue image")


class EmbeddingResponse(BaseModel):
    dimensions: int
    embedding: List[float]
    model: str
    cached: bool = False


class CandidateItem(BaseModel):
    id: str
    image_url: Optional[str] = None
    embedding: Optional[List[float]] = None
    embedding_model: Optional[str] = None


class CompareRequest(BaseModel):
    target_embedding: Optional[List[float]] = None
    target_image_url: Optional[str] = None
    target_model: Optional[str] = None
    candidates: List[CandidateItem]
    threshold: float = Field(0.85, ge=0.0, le=1.0)


class RankedCandidate(BaseModel):
    id: str
    similarity: float
    is_duplicate: bool
    verified: bool = True
    unverified_reason: Optional[str] = None


class CompareResponse(BaseModel):
    threshold: float
    has_duplicate: bool
    top_match: Optional[RankedCandidate] = None
    ranked_candidates: List[RankedCandidate]
    unverified_count: int = 0


@app.get("/health")
def health_check():
    """Liveness probe: reports overall server status, truthful model identity, OCR availability, and configuration."""
    ready, model_reported, err = is_model_ready()
    info = get_active_model_info()
    tesseract_ready, tesseract_ver = is_tesseract_available()
    return {
        "status": "ok",
        "live": True,
        "ready": ready,
        "service": "civicvision-ai-clip",
        "version": "1.2.0",
        "model": info["model_name"],
        "device": DEVICE,
        "mode": info["mode"],
        "use_online_model": os.getenv("USE_ONLINE_MODEL", "false").lower() == "true",
        "initialization_error": err,
        "cache_entries": len(EMBEDDING_CACHE),
        "allowed_hosts": ALLOWED_HOSTS,
        "max_image_bytes": MAX_IMAGE_BYTES,
        "civic_classifier_ready": (_civic_model is not None),
        "civic_checkpoint": CIVIC_MODEL_PATH or None,
        "ocr_available": tesseract_ready,
        "ocr_engine": "tesseract" if tesseract_ready else "unavailable",
        "ocr_version": tesseract_ver if tesseract_ready else None
    }


@app.get("/ready")
def readiness_check():
    """Readiness probe: distinguishes server health from real-model readiness. Returns 503 if not ready."""
    ready, model_reported, err = is_model_ready()
    info = get_active_model_info()
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "ready": False,
                "mode": info["mode"],
                "error": err or "Online model requested but not initialized"
            }
        )
    return {
        "status": "ready",
        "ready": True,
        "mode": info["mode"],
        "model": info["model_name"]
    }


@app.post("/embed-image", response_model=EmbeddingResponse, dependencies=[Depends(verify_api_key)])
def embed_image_url(payload: EmbedUrlRequest):
    """Generates a 512-dim embedding from an image URL with caching and truthful model metadata."""
    url = payload.image_url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="image_url must not be empty.")

    # Check cache
    if url in EMBEDDING_CACHE:
        cached_entry = EMBEDDING_CACHE[url]
        return EmbeddingResponse(
            dimensions=EMBEDDING_DIM,
            embedding=cached_entry["embedding"],
            model=cached_entry["model"],
            cached=True
        )

    image = load_image_from_url(url)
    embedding, model_used = compute_clip_embedding(image)

    # Update LRU cache
    if len(EMBEDDING_CACHE) >= MAX_CACHE_SIZE:
        EMBEDDING_CACHE.pop(next(iter(EMBEDDING_CACHE)))
    EMBEDDING_CACHE[url] = {
        "embedding": embedding,
        "model": model_used
    }

    return EmbeddingResponse(
        dimensions=EMBEDDING_DIM,
        embedding=embedding,
        model=model_used,
        cached=False
    )


@app.post("/embed-upload", response_model=EmbeddingResponse, dependencies=[Depends(verify_api_key)])
async def embed_image_upload(file: UploadFile = File(...)):
    """Generates a 512-dim embedding from an uploaded image file with truthful model metadata."""
    content = await file.read()
    image = load_image_from_bytes(content)
    embedding, model_used = compute_clip_embedding(image)

    return EmbeddingResponse(
        dimensions=EMBEDDING_DIM,
        embedding=embedding,
        model=model_used,
        cached=False
    )


@app.post("/compare-similarity", response_model=CompareResponse, dependencies=[Depends(verify_api_key)])
def compare_similarity(payload: CompareRequest):
    """
    Compares target image embedding against a list of Stage 1 candidates.
    Returns cosine similarities, model compatibility checks, and flags matches above threshold.
    """
    target_vec = payload.target_embedding
    active_model = payload.target_model

    # If target_embedding was not pre-computed, compute from target_image_url
    if not target_vec and payload.target_image_url:
        url = payload.target_image_url.strip()
        if url in EMBEDDING_CACHE:
            target_vec = EMBEDDING_CACHE[url]["embedding"]
            active_model = EMBEDDING_CACHE[url]["model"]
        else:
            image = load_image_from_url(url)
            target_vec, active_model = compute_clip_embedding(image)
            EMBEDDING_CACHE[url] = {"embedding": target_vec, "model": active_model}

    if not target_vec or len(target_vec) != EMBEDDING_DIM:
        raise HTTPException(
            status_code=400,
            detail=f"Valid {EMBEDDING_DIM}-dimensional target vector or image URL required."
        )

    ranked = []
    unverified_count = 0

    for cand in payload.candidates:
        cand_vec = cand.embedding
        cand_model = cand.embedding_model

        # If candidate embedding not present, attempt to resolve from image_url
        if not cand_vec and cand.image_url:
            c_url = cand.image_url.strip()
            if c_url in EMBEDDING_CACHE:
                cand_vec = EMBEDDING_CACHE[c_url]["embedding"]
                cand_model = EMBEDDING_CACHE[c_url]["model"]
            else:
                try:
                    img = load_image_from_url(c_url)
                    cand_vec, cand_model = compute_clip_embedding(img)
                    EMBEDDING_CACHE[c_url] = {"embedding": cand_vec, "model": cand_model}
                except Exception:
                    cand_vec = None

        # Check candidate vector validity and model compatibility
        if not cand_vec or len(cand_vec) != EMBEDDING_DIM:
            unverified_count += 1
            ranked.append(RankedCandidate(
                id=cand.id,
                similarity=0.0,
                is_duplicate=False,
                verified=False,
                unverified_reason="Missing or malformed candidate vector"
            ))
            continue

        if active_model and cand_model and active_model.strip().lower() != cand_model.strip().lower():
            unverified_count += 1
            ranked.append(RankedCandidate(
                id=cand.id,
                similarity=0.0,
                is_duplicate=False,
                verified=False,
                unverified_reason=f"Incompatible models: target='{active_model}' vs candidate='{cand_model}'"
            ))
            continue

        sim = cosine_similarity(target_vec, cand_vec)
        is_dup = sim >= payload.threshold

        ranked.append(RankedCandidate(
            id=cand.id,
            similarity=sim,
            is_duplicate=is_dup,
            verified=True
        ))

    # Sort descending by similarity
    ranked.sort(key=lambda x: x.similarity, reverse=True)

    top = ranked[0] if ranked and ranked[0].is_duplicate and ranked[0].verified else None
    has_dup = any(c.is_duplicate and c.verified for c in ranked)

    return CompareResponse(
        threshold=payload.threshold,
        has_duplicate=has_dup,
        top_match=top,
        ranked_candidates=ranked,
        unverified_count=unverified_count
    )


class ClassifyIssueRequest(BaseModel):
    image_url: str = Field(..., description="Public HTTP/HTTPS URL of the issue image")
    candidate_category: Optional[str] = Field(None, description="Optional citizen-reported defect category")


class ClassifyIssueResponse(BaseModel):
    category: Optional[str] = Field(None, description="Classified defect category")
    confidence: Optional[float] = Field(None, description="Classification confidence [0.0, 1.0]")
    severity: Optional[float] = Field(None, description="Estimated severity score [1.0, 10.0]")
    suggested_department: Optional[str] = Field(None, description="Department suggested by classification")
    model: str = Field(..., description="Truthful model identifier")
    mode: str = Field(..., description="Operational mode: trained_checkpoint, checkpoint_unavailable, or inference_error")
    is_trained_model: bool = Field(False, description="Whether a genuine trained checkpoint was used")
    severity_mode: Optional[str] = Field(None, description="Severity estimator mode: rule_based_heuristic or null")
    status: str = Field(..., description="Inference status: classified, unverified, unavailable, or error")
    detected_classes: Optional[List[str]] = Field(default_factory=list, description="All categories exceeding calibrated threshold")
    probabilities: Optional[Dict[str, float]] = Field(default_factory=dict, description="Sigmoid probabilities for defect classes")
    thresholds: Optional[Dict[str, float]] = Field(None, description="Calibrated decision thresholds used")
    model_version: Optional[str] = Field(None, description="Model checkpoint identifier")
    error: Optional[str] = Field(None, description="Error details if inference failed")


@app.post("/classify-issue", response_model=ClassifyIssueResponse, dependencies=[Depends(verify_api_key)])
def classify_issue_url(payload: ClassifyIssueRequest):
    """
    Classifies a civic issue image from a verified URL and provides severity baseline.
    Uses trained MobileNetV3-Small checkpoint when configured, or returns truthful
    unavailable status when unconfigured.
    """
    url = payload.image_url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="image_url must not be empty.")

    image = load_image_from_url(url)
    res = classify_road_defect_image(image, payload.candidate_category)
    return ClassifyIssueResponse(**res)


@app.post("/classify-upload", response_model=ClassifyIssueResponse, dependencies=[Depends(verify_api_key)])
async def classify_issue_upload(
    file: UploadFile = File(...),
    candidate_category: Optional[str] = None
):
    """Classifies an uploaded image file and returns structured predictions with truthful metadata."""
    content = await file.read()
    image = load_image_from_bytes(content)
    res = classify_road_defect_image(image, candidate_category)
    return ClassifyIssueResponse(**res)


@app.post("/predict-road-defect", response_model=ClassifyIssueResponse, dependencies=[Depends(verify_api_key)])
async def predict_road_defect(
    file: UploadFile = File(...),
    candidate_category: Optional[str] = None
):
    """
    Dedicated endpoint for road defect classification from an uploaded image file.
    Validates upload format/size, runs MobileNetV3-Small with calibrated thresholds,
    and returns multi-label probabilities, confidence, and category assignment.
    """
    content = await file.read()
    image = load_image_from_bytes(content)
    res = classify_road_defect_image(image, candidate_category)
    return ClassifyIssueResponse(**res)


# ============================================================================
# OCR GPS Extraction Engine (Phase F5-B / Feature F5)
# ============================================================================

class OcrGpsUrlRequest(BaseModel):
    image_url: str = Field(..., description="Public HTTP/HTTPS URL of the civic issue photo")


class OcrGpsResponse(BaseModel):
    success: bool = Field(..., description="Whether OCR execution completed without system errors")
    found: bool = Field(..., description="Whether valid GPS coordinates were successfully parsed")
    latitude: Optional[float] = Field(None, description="Extracted latitude in decimal degrees [-90.0, +90.0]")
    longitude: Optional[float] = Field(None, description="Extracted longitude in decimal degrees [-180.0, +180.0]")
    raw_text: Optional[str] = Field(None, description="Extracted OCR text, bounded in length")
    confidence: Optional[float] = Field(None, description="Heuristic pattern confidence score [0.0, 1.0] (not a calibrated probability)")
    format: Optional[str] = Field(None, description="Format detected: decimal_degrees, degrees_minutes_seconds, or None")
    error: Optional[str] = Field(None, description="Reason if coordinates could not be extracted or if OCR failed")


# DMS Regex Patterns
# Full paired DMS (on same line) - prevents prefix and suffix collision
DMS_PAIR_SUFFIX = re.compile(
    r'(?<![A-Za-z0-9.])(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*([NSns])\s*[,;\s/|]+\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*([EWew])(?![A-Za-z0-9])'
)
DMS_PAIR_PREFIX = re.compile(
    r'(?<![A-Za-z0-9])([NSns])\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*[,;\s/|]+\s*([EWew])\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?(?![A-Za-z0-9])'
)
DMS_PAIR_SUFFIX_REV = re.compile(
    r'(?<![A-Za-z0-9.])(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*([EWew])\s*[,;\s/|]+\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*([NSns])(?![A-Za-z0-9])'
)
DMS_PAIR_PREFIX_REV = re.compile(
    r'(?<![A-Za-z0-9])([EWew])\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*[,;\s/|]+\s*([NSns])\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?(?![A-Za-z0-9])'
)

# Single Component DMS Patterns (for separate lines)
DMS_COMPONENT_SUFFIX = re.compile(
    r'(?<![A-Za-z0-9.])(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?\s*([NSEWnsew])(?![A-Za-z0-9])'
)
DMS_COMPONENT_PREFIX = re.compile(
    r'(?<![A-Za-z0-9])([NSEWnsew])\s*(\d{1,3})\s*(?:°|deg|degrees|\*|\^|d)?\s*(\d{1,2})\s*(?:\'|’|min|m)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:"|”|\'\'|sec|s)?(?![A-Za-z0-9])'
)

# Labeled Decimal Degrees (Lat / Lon)
LABELED_LAT = re.compile(
    r'(?i)\b(?:lat|latitude)\s*[:=]?\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*(?:°|deg)?\s*([NSns])?\b'
)
LABELED_LAT_PREFIX = re.compile(
    r'(?i)\b(?:lat|latitude)\s*[:=]?\s*([NSns])\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*(?:°|deg)?\b'
)

LABELED_LON = re.compile(
    r'(?i)\b(?:lon|long|lng|longitude)\s*[:=]?\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*(?:°|deg)?\s*([EWew])?\b'
)
LABELED_LON_PREFIX = re.compile(
    r'(?i)\b(?:lon|long|lng|longitude)\s*[:=]?\s*([EWew])\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s*(?:°|deg)?\b'
)

# Unlabeled Decimal Degrees with Hemisphere Suffixes/Prefixes
UNLABELED_PAIR_SUFFIX = re.compile(
    r'(?<![A-Za-z0-9.])([+-]?[0-9]{1,2}(?:\.[0-9]{2,8}))\s*°?\s*([NSns])\s*[,;\s/|]+\s*([+-]?[0-9]{1,3}(?:\.[0-9]{2,8}))\s*°?\s*([EWew])(?![A-Za-z0-9])'
)
UNLABELED_PAIR_PREFIX = re.compile(
    r'(?<![A-Za-z0-9])([NSns])\s*([+-]?[0-9]{1,2}(?:\.[0-9]{2,8}))\s*°?\s*[,;\s/|]+\s*([EWew])\s*([+-]?[0-9]{1,3}(?:\.[0-9]{2,8}))\s*°?(?![A-Za-z0-9])'
)

# GPS / Location prefix with decimal coordinates
GPS_PREFIX_PAIR = re.compile(
    r'(?i)\b(?:gps|location|coord|coordinates|geo)\s*[:=]?\s*([+-]?[0-9]{1,2}\.[0-9]{2,8})\s*[,;\s/|]+\s*([+-]?[0-9]{1,3}\.[0-9]{2,8})\b'
)


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Computes great-circle distance between two GPS coordinates in meters
    using the Haversine formula on a spherical Earth (R = 6,371,000 meters).
    """
    R = 6371000.0  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +
         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


def validate_coordinates(lat: float, lon: float) -> bool:
    """
    Validates that latitude and longitude are within standard geographic boundaries.
    - Latitude: [-90.0, +90.0]
    - Longitude: [-180.0, +180.0]
    """
    if lat is None or lon is None:
        return False
    if not math.isfinite(lat) or not math.isfinite(lon):
        return False
    if not (-90.0 <= lat <= 90.0):
        return False
    if not (-180.0 <= lon <= 180.0):
        return False
    return True


def dms_to_decimal(degrees: float, minutes: float, seconds: float, hemisphere: str) -> Optional[float]:
    """
    Converts degrees, minutes, seconds and hemisphere to signed decimal degrees.
    Strictly validates range:
    - 0 <= minutes < 60
    - 0 <= seconds < 60
    - Latitude: 0 <= degrees <= 90 (if degrees == 90, minutes and seconds must be 0)
    - Longitude: 0 <= degrees <= 180 (if degrees == 180, minutes and seconds must be 0)
    """
    if not (0.0 <= minutes < 60.0):
        return None
    if not (0.0 <= seconds < 60.0):
        return None

    hemi = hemisphere.upper().strip()
    if hemi in ("N", "S"):
        if not (0.0 <= degrees <= 90.0):
            return None
        if degrees == 90.0 and (minutes > 0.0 or seconds > 0.0):
            return None
    elif hemi in ("E", "W"):
        if not (0.0 <= degrees <= 180.0):
            return None
        if degrees == 180.0 and (minutes > 0.0 or seconds > 0.0):
            return None
    else:
        return None

    val = float(degrees) + (float(minutes) / 60.0) + (float(seconds) / 3600.0)
    if hemi in ("S", "W"):
        val = -abs(val)
    elif hemi in ("N", "E"):
        val = abs(val)

    return round(val, 6)


def _spans_overlap(s1: Tuple[int, int], s2: Tuple[int, int]) -> bool:
    return s1[0] < s2[1] and s1[1] > s2[0]


def parse_dms_candidates(text: str) -> List[Dict[str, Any]]:
    """Extracts DMS coordinate pairs with paired regex and single-line/cross-line support."""
    candidates = []
    lines = text.splitlines()

    # 1. First search for complete DMS pairs on each line
    for line in lines:
        if not line.strip():
            continue

        for m in DMS_PAIR_SUFFIX.finditer(line):
            lat = dms_to_decimal(float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4))
            lon = dms_to_decimal(float(m.group(5)), float(m.group(6)), float(m.group(7)), m.group(8))
            if lat is not None and lon is not None and validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": lat,
                    "longitude": lon,
                    "confidence": 0.95,
                    "format": "degrees_minutes_seconds"
                })

        for m in DMS_PAIR_PREFIX.finditer(line):
            lat = dms_to_decimal(float(m.group(2)), float(m.group(3)), float(m.group(4)), m.group(1))
            lon = dms_to_decimal(float(m.group(6)), float(m.group(7)), float(m.group(8)), m.group(5))
            if lat is not None and lon is not None and validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": lat,
                    "longitude": lon,
                    "confidence": 0.95,
                    "format": "degrees_minutes_seconds"
                })

        for m in DMS_PAIR_SUFFIX_REV.finditer(line):
            lon = dms_to_decimal(float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4))
            lat = dms_to_decimal(float(m.group(5)), float(m.group(6)), float(m.group(7)), m.group(8))
            if lat is not None and lon is not None and validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": lat,
                    "longitude": lon,
                    "confidence": 0.95,
                    "format": "degrees_minutes_seconds"
                })

        for m in DMS_PAIR_PREFIX_REV.finditer(line):
            lon = dms_to_decimal(float(m.group(2)), float(m.group(3)), float(m.group(4)), m.group(1))
            lat = dms_to_decimal(float(m.group(6)), float(m.group(7)), float(m.group(8)), m.group(5))
            if lat is not None and lon is not None and validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": lat,
                    "longitude": lon,
                    "confidence": 0.95,
                    "format": "degrees_minutes_seconds"
                })

    if candidates:
        return candidates

    # 2. If no full pair was on a single line, check for individual components across lines
    # (e.g. Lat on line 1, Lon on line 2)
    lats = []
    lons = []

    for line in lines:
        if not line.strip():
            continue

        comps = []
        matched_spans = []

        # Check prefix first (e.g. S 11°... or N 11°...)
        for m in DMS_COMPONENT_PREFIX.finditer(line):
            val = dms_to_decimal(float(m.group(2)), float(m.group(3)), float(m.group(4)), m.group(1))
            if val is not None:
                comps.append((val, m.group(1).upper(), m.start()))
                matched_spans.append((m.start(), m.end()))

        # Check suffix for remaining non-overlapping spans
        for m in DMS_COMPONENT_SUFFIX.finditer(line):
            if any(_spans_overlap((m.start(), m.end()), s) for s in matched_spans):
                continue
            val = dms_to_decimal(float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4))
            if val is not None:
                comps.append((val, m.group(4).upper(), m.start()))
                matched_spans.append((m.start(), m.end()))

        for val, hemi, _ in comps:
            if hemi in ("N", "S"):
                lats.append(val)
            elif hemi in ("E", "W"):
                lons.append(val)

    if len(lats) == 1 and len(lons) == 1:
        if validate_coordinates(lats[0], lons[0]):
            candidates.append({
                "latitude": lats[0],
                "longitude": lons[0],
                "confidence": 0.95,
                "format": "degrees_minutes_seconds"
            })

    return candidates


def parse_decimal_candidates(text: str) -> List[Dict[str, Any]]:
    """Extracts decimal degree coordinate pairs from labeled and hemisphere-marked patterns."""
    candidates = []

    # 1. Check GPS/Location prefixed pairs
    for m in GPS_PREFIX_PAIR.finditer(text):
        try:
            lat = float(m.group(1))
            lon = float(m.group(2))
            if validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": lat,
                    "longitude": lon,
                    "confidence": 0.85,
                    "format": "decimal_degrees"
                })
        except ValueError:
            pass

    # 2. Check unlabeled pairs with explicit hemisphere suffixes: 11.342423 N 77.728165 E
    for m in UNLABELED_PAIR_SUFFIX.finditer(text):
        try:
            lat_val = float(m.group(1))
            lat_hemi = m.group(2).upper()
            lon_val = float(m.group(3))
            lon_hemi = m.group(4).upper()

            lat = -abs(lat_val) if lat_hemi == "S" else abs(lat_val)
            lon = -abs(lon_val) if lon_hemi == "W" else abs(lon_val)

            if validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "confidence": 0.80,
                    "format": "decimal_degrees"
                })
        except ValueError:
            pass

    # 3. Check unlabeled pairs with prefix hemisphere: N 11.342423, E 77.728165
    for m in UNLABELED_PAIR_PREFIX.finditer(text):
        try:
            lat_hemi = m.group(1).upper()
            lat_val = float(m.group(2))
            lon_hemi = m.group(3).upper()
            lon_val = float(m.group(4))

            lat = -abs(lat_val) if lat_hemi == "S" else abs(lat_val)
            lon = -abs(lon_val) if lon_hemi == "W" else abs(lon_val)

            if validate_coordinates(lat, lon):
                candidates.append({
                    "latitude": round(lat, 6),
                    "longitude": round(lon, 6),
                    "confidence": 0.80,
                    "format": "decimal_degrees"
                })
        except ValueError:
            pass

    # 4. Check explicit Lat: / Long: labels (line-by-line or full text)
    lats = []
    for m in LABELED_LAT.finditer(text):
        val = float(m.group(1))
        hemi = m.group(2)
        if hemi:
            val = -abs(val) if hemi.upper() == "S" else abs(val)
        lats.append((round(val, 6), m.start()))

    for m in LABELED_LAT_PREFIX.finditer(text):
        hemi = m.group(1)
        val = float(m.group(2))
        val = -abs(val) if hemi.upper() == "S" else abs(val)
        lats.append((round(val, 6), m.start()))

    lons = []
    for m in LABELED_LON.finditer(text):
        val = float(m.group(1))
        hemi = m.group(2)
        if hemi:
            val = -abs(val) if hemi.upper() == "W" else abs(val)
        lons.append((round(val, 6), m.start()))

    for m in LABELED_LON_PREFIX.finditer(text):
        hemi = m.group(1)
        val = float(m.group(2))
        val = -abs(val) if hemi.upper() == "W" else abs(val)
        lons.append((round(val, 6), m.start()))

    if len(lats) == 1 and len(lons) == 1:
        if validate_coordinates(lats[0][0], lons[0][0]):
            candidates.append({
                "latitude": lats[0][0],
                "longitude": lons[0][0],
                "confidence": 0.90,
                "format": "decimal_degrees"
            })
    elif len(lats) > 1 or len(lons) > 1:
        for lat_val, lat_pos in lats:
            best_lon = None
            min_dist = 1000
            for lon_val, lon_pos in lons:
                dist = abs(lat_pos - lon_pos)
                if dist < min_dist:
                    min_dist = dist
                    best_lon = lon_val
            if best_lon is not None and min_dist < 120:
                if validate_coordinates(lat_val, best_lon):
                    candidates.append({
                        "latitude": lat_val,
                        "longitude": best_lon,
                        "confidence": 0.90,
                        "format": "decimal_degrees"
                    })

    return candidates


def parse_coordinate_text(raw_text: str) -> Dict[str, Any]:
    """
    Main parser: searches raw OCR text for DMS and decimal degree coordinates.
    Conservative parsing: requires explicit labels, hemispheres, or coordinate structure.
    Rejects dates, timestamps, phone numbers, speeds, malformed pairs, and conflicting candidate pairs.
    Ambiguity is evaluated using physical Haversine distance (100-meter threshold) rather than
    fixed angular difference, ensuring consistency across all latitudes.
    """
    if not raw_text or not raw_text.strip():
        return {
            "found": False,
            "latitude": None,
            "longitude": None,
            "confidence": None,
            "format": None,
            "error": "No text provided for OCR parsing"
        }

    cleaned_text = raw_text[:2000]

    dms_candidates = parse_dms_candidates(cleaned_text)
    dec_candidates = parse_decimal_candidates(cleaned_text)

    all_candidates = dms_candidates + dec_candidates

    if not all_candidates:
        return {
            "found": False,
            "latitude": None,
            "longitude": None,
            "confidence": None,
            "format": None,
            "error": "No GPS coordinates detected in image text"
        }

    # Deduplicate candidates within 10 meters using Haversine distance
    unique_candidates = []
    for cand in all_candidates:
        dup = False
        for u in unique_candidates:
            if haversine_distance(cand["latitude"], cand["longitude"], u["latitude"], u["longitude"]) <= 10.0:
                dup = True
                if cand["confidence"] > u["confidence"]:
                    u["confidence"] = cand["confidence"]
                    u["format"] = cand["format"]
                break
        if not dup:
            unique_candidates.append(cand)

    if len(unique_candidates) == 1:
        top = unique_candidates[0]
        return {
            "found": True,
            "latitude": top["latitude"],
            "longitude": top["longitude"],
            "confidence": top["confidence"],
            "format": top["format"],
            "error": None
        }

    # Multiple distinct candidates: check for material physical conflict (> 100 meters)
    first = unique_candidates[0]
    for other in unique_candidates[1:]:
        dist_m = haversine_distance(first["latitude"], first["longitude"], other["latitude"], other["longitude"])
        if dist_m > 100.0:
            return {
                "found": False,
                "latitude": None,
                "longitude": None,
                "confidence": None,
                "format": None,
                "error": "Ambiguous coordinates: multiple conflicting coordinate candidates detected"
            }

    unique_candidates.sort(key=lambda x: x["confidence"], reverse=True)
    chosen = unique_candidates[0]
    return {
        "found": True,
        "latitude": chosen["latitude"],
        "longitude": chosen["longitude"],
        "confidence": chosen["confidence"],
        "format": chosen["format"],
        "error": None
    }


def is_tesseract_available() -> Tuple[bool, Optional[str]]:
    """Checks if Tesseract OCR executable is available on host system."""
    try:
        import pytesseract
        ver = pytesseract.get_tesseract_version()
        return True, str(ver)
    except Exception as e:
        return False, str(e)


def extract_text_from_image(image: Image.Image, timeout: float = OCR_TIMEOUT_SECONDS) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Safely executes Tesseract OCR on a validated PIL Image.
    Returns tuple: (success: bool, raw_text: Optional[str], error_message: Optional[str])
    """
    if image is None:
        return False, None, "Invalid or missing image"

    tess_available, tess_err = is_tesseract_available()
    if not tess_available:
        logger.warning(f"Tesseract executable not available on host: {tess_err}")
        return False, None, "Tesseract OCR executable not installed on host"

    try:
        import pytesseract
        ocr_img = image.convert("RGB") if image.mode not in ("RGB", "L") else image
        text = pytesseract.image_to_string(ocr_img, timeout=timeout)
        return True, text, None
    except pytesseract.TesseractNotFoundError:
        return False, None, "Tesseract OCR executable not installed on host"
    except (subprocess.TimeoutExpired, pytesseract.TesseractError) as e:
        logger.warning(f"Tesseract OCR execution error/timeout: {e}")
        return False, None, "OCR execution failed or timed out"
    except Exception as e:
        logger.warning(f"Unexpected error during OCR execution: {e}")
        return False, None, "OCR processing failed"


@app.post("/extract-ocr-gps", response_model=OcrGpsResponse, dependencies=[Depends(verify_api_key)])
def extract_ocr_gps_url(payload: OcrGpsUrlRequest):
    """
    Extracts GPS coordinates from visible text on an image retrieved from a URL.
    Reuses existing load_image_from_url with full SSRF, allowlist, and size protections.
    """
    url = payload.image_url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="image_url must not be empty.")

    image = load_image_from_url(url)
    ocr_ok, raw_text, ocr_err = extract_text_from_image(image, timeout=OCR_TIMEOUT_SECONDS)
    if not ocr_ok:
        return OcrGpsResponse(
            success=False,
            found=False,
            latitude=None,
            longitude=None,
            raw_text=None,
            confidence=None,
            format=None,
            error=ocr_err
        )

    parsed = parse_coordinate_text(raw_text)
    return OcrGpsResponse(
        success=True,
        found=parsed["found"],
        latitude=parsed["latitude"],
        longitude=parsed["longitude"],
        raw_text=raw_text[:1000] if raw_text else "",
        confidence=parsed["confidence"],
        format=parsed["format"],
        error=parsed["error"]
    )


@app.post("/extract-ocr-upload", response_model=OcrGpsResponse, dependencies=[Depends(verify_api_key)])
async def extract_ocr_upload(file: UploadFile = File(...)):
    """
    Extracts GPS coordinates from visible text on an uploaded image file.
    Reuses existing load_image_from_bytes with format whitelist and decompression bomb checks.
    """
    content = await file.read()
    image = load_image_from_bytes(content)

    ocr_ok, raw_text, ocr_err = extract_text_from_image(image, timeout=OCR_TIMEOUT_SECONDS)
    if not ocr_ok:
        return OcrGpsResponse(
            success=False,
            found=False,
            latitude=None,
            longitude=None,
            raw_text=None,
            confidence=None,
            format=None,
            error=ocr_err
        )

    parsed = parse_coordinate_text(raw_text)
    return OcrGpsResponse(
        success=True,
        found=parsed["found"],
        latitude=parsed["latitude"],
        longitude=parsed["longitude"],
        raw_text=raw_text[:1000] if raw_text else "",
        confidence=parsed["confidence"],
        format=parsed["format"],
        error=parsed["error"]
    )


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    logger.info(f"Starting CivicVision AI CLIP service on {host}:{port}...")
    uvicorn.run("main:app", host=host, port=port, reload=False)
