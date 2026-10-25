"""
CivicVision AI — Dataset Preparation and Manifest Generator (Phase F6-B1)

Reproducible, auditable dataset preparation pipeline for MobileNetV3 civic defect classification.

Key Capabilities:
1. Annotation parsing: Pascal VOC XML (RDD2022) and COCO JSON (TACO / TrashNet), plus ImageFolder structures.
2. Defensible canonical category mapping for the 8 canonical classes:
   ['pothole', 'road_damage', 'garbage', 'street_light', 'water_leak', 'sewage', 'traffic_signal', 'other']
   Strict rule: Unsupported or ambiguous labels are NEVER silently assigned to 'other'.
3. Image integrity verification: Magic bytes check, PIL verify, resolution limits, and corrupt image detection.
4. Content deduplication: SHA-256 exact-match hashing and perceptual average hashing.
5. Group-aware splitting: Preserves source-image identity (group_id) across bounding-box crops or video sequences.
   Guarantees 0% split leakage across Train (70%), Validation (15%), and Test (15%) splits.
6. Provenance and class-balance audit reporting with minimum sample warnings.
"""

import os
import sys
import json
import csv
import hashlib
import argparse
import random
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Set, Any
from PIL import Image, UnidentifiedImageError

# -----------------------------------------------------------------------------
# Canonical Category Definitions & Strict Mapping Rules
# -----------------------------------------------------------------------------

CANONICAL_CATEGORIES: List[str] = [
    "pothole",
    "road_damage",
    "garbage",
    "street_light",
    "water_leak",
    "sewage",
    "traffic_signal",
    "other"
]

# Explicit, defensible source label mappings
# Format: raw_label_normalized -> (canonical_category, rationale)
LABEL_MAPPING_RULES: Dict[str, Tuple[str, str]] = {
    # RDD2022 / Road Defect mappings
    "d40": ("pothole", "RDD2022 D40 represents potholes"),
    "pothole": ("pothole", "Direct category match for pothole"),
    "potholes": ("pothole", "Plural alias for pothole"),
    "d00": ("road_damage", "RDD2022 D00 represents longitudinal cracking"),
    "d0w0": ("road_damage", "RDD2022 annotator typo for D00 longitudinal crack"),
    "d10": ("road_damage", "RDD2022 D10 represents transverse cracking"),
    "d20": ("road_damage", "RDD2022 D20 represents alligator cracking"),
    "road_damage": ("road_damage", "Direct category match for general road surface damage"),
    "road-damage": ("road_damage", "Hyphenated alias for road damage"),
    "crack": ("road_damage", "Road asphalt crack defect"),
    "cracks": ("road_damage", "Plural road asphalt crack defect"),
    "unpaved_road": ("road_damage", "Severe unpaved / degraded road surface"),
    "unpaved-road": ("road_damage", "Severe unpaved / degraded road surface"),

    # Waste / Litter mappings (TACO, TrashNet, OpenLitterMap)
    "garbage": ("garbage", "Direct category match for municipal solid waste"),
    "trash": ("garbage", "Municipal solid waste / trash alias"),
    "waste": ("garbage", "Municipal solid waste alias"),
    "litter": ("garbage", "Street litter alias"),
    "debris": ("garbage", "Street debris / rubbish alias"),
    "illegal_dumping": ("garbage", "Illegal waste pile / dumping"),
    "illegal-dumping": ("garbage", "Illegal waste pile / dumping"),
    "overflowing_dustbin": ("garbage", "Overflowing waste receptacle"),
    "overflowing-dustbin": ("garbage", "Overflowing waste receptacle"),
    "bottle": ("garbage", "TACO plastic/glass litter item"),
    "bottles": ("garbage", "TACO plastic/glass litter item"),
    "plastic_bottle": ("garbage", "TACO plastic bottle litter item"),
    "clear_plastic_bottle": ("garbage", "TACO clear plastic bottle litter item"),
    "other_plastic_bottle": ("garbage", "TACO plastic bottle litter item"),
    "glass_bottle": ("garbage", "TACO glass bottle litter item"),
    "plastic": ("garbage", "TACO plastic litter item"),
    "plastic_bag": ("garbage", "TACO plastic bag litter item"),
    "can": ("garbage", "TACO metal can litter item"),
    "cans": ("garbage", "TACO metal can litter item"),
    "food_can": ("garbage", "TACO food can litter item"),
    "drink_can": ("garbage", "TACO beverage can litter item"),
    "aerosol": ("garbage", "TACO aerosol can litter item"),
    "cardboard": ("garbage", "TrashNet cardboard litter"),
    "paper": ("garbage", "TrashNet paper litter"),
    "wrapper": ("garbage", "TACO food wrapper litter item"),
    "cigarette": ("garbage", "TACO cigarette butt litter item"),
    "aluminium_foil": ("garbage", "TACO aluminum foil litter item"),
    "battery": ("garbage", "TACO battery discarded item"),
    "aluminium_blister_pack": ("garbage", "TACO blister pack litter item"),
    "carded_blister_pack": ("garbage", "TACO blister pack litter item"),
    "plastic_bottle_cap": ("garbage", "TACO plastic bottle cap litter item"),
    "metal_bottle_cap": ("garbage", "TACO metal bottle cap litter item"),
    "broken_glass": ("garbage", "TACO broken glass litter item"),
    "toilet_tube": ("garbage", "TACO cardboard tube litter item"),
    "other_carton": ("garbage", "TACO carton packaging litter"),
    "egg_carton": ("garbage", "TACO egg carton litter item"),
    "drink_carton": ("garbage", "TACO drink carton litter item"),
    "corrugated_carton": ("garbage", "TACO corrugated carton litter item"),
    "meal_carton": ("garbage", "TACO meal carton litter item"),
    "pizza_box": ("garbage", "TACO pizza box litter item"),
    "paper_cup": ("garbage", "TACO paper cup litter item"),
    "disposable_plastic_cup": ("garbage", "TACO plastic cup litter item"),
    "foam_cup": ("garbage", "TACO foam cup litter item"),
    "glass_cup": ("garbage", "TACO glass cup litter item"),
    "other_plastic_cup": ("garbage", "TACO plastic cup litter item"),
    "food_waste": ("garbage", "TACO organic street food waste"),
    "glass_jar": ("garbage", "TACO glass jar litter item"),
    "plastic_lid": ("garbage", "TACO plastic lid litter item"),
    "metal_lid": ("garbage", "TACO metal lid litter item"),
    "other_plastic": ("garbage", "TACO miscellaneous plastic litter"),
    "magazine_paper": ("garbage", "TACO magazine paper litter item"),
    "tissues": ("garbage", "TACO tissue paper litter item"),
    "wrapping_paper": ("garbage", "TACO wrapping paper litter item"),
    "normal_paper": ("garbage", "TACO paper litter item"),
    "paper_bag": ("garbage", "TACO paper bag litter item"),
    "plastified_paper_bag": ("garbage", "TACO paper bag litter item"),
    "plastic_film": ("garbage", "TACO plastic film litter item"),
    "six_pack_rings": ("garbage", "TACO plastic packaging ring litter"),
    "garbage_bag": ("garbage", "TACO plastic garbage bag litter item"),
    "other_plastic_wrapper": ("garbage", "TACO plastic wrapper litter item"),
    "single-use_carrier_bag": ("garbage", "TACO plastic carrier bag litter"),
    "polypropylene_bag": ("garbage", "TACO plastic bag litter item"),
    "crisp_packet": ("garbage", "TACO snack wrapper litter item"),
    "spread_tub": ("garbage", "TACO plastic container litter item"),
    "tupperware": ("garbage", "TACO plastic container litter item"),
    "disposable_food_container": ("garbage", "TACO takeout food container litter"),
    "foam_food_container": ("garbage", "TACO foam food container litter"),
    "other_plastic_container": ("garbage", "TACO plastic container litter"),
    "plastic_glooves": ("garbage", "TACO discarded plastic gloves litter"),
    "plastic_utensils": ("garbage", "TACO plastic utensils cutlery litter"),
    "pop_tab": ("garbage", "TACO beverage can pop tab litter"),
    "rope_&_strings": ("garbage", "TACO discarded rope/string rubbish"),
    "scrap_metal": ("garbage", "TACO scrap metal waste item"),
    "shoe": ("garbage", "TACO discarded shoe litter item"),
    "squeezable_tube": ("garbage", "TACO squeezable packaging tube litter"),
    "plastic_straw": ("garbage", "TACO plastic straw litter item"),
    "paper_straw": ("garbage", "TACO paper straw litter item"),
    "styrofoam_piece": ("garbage", "TACO styrofoam litter item"),
    "unlabeled_litter": ("garbage", "TACO general street litter"),

    # Street Lighting mappings
    "street_light": ("street_light", "Direct category match for street lighting infrastructure"),
    "street-light": ("street_light", "Hyphenated alias for street light"),
    "streetlight": ("street_light", "Single-word alias for street light"),
    "street_light_out": ("street_light", "Dark / unlit street lamp defect"),
    "broken_streetlight": ("street_light", "Damaged / non-functional street lamp"),
    "lamp_post": ("street_light", "Damaged municipal lamp post"),

    # Water Leak mappings
    "water_leak": ("water_leak", "Direct category match for clean water distribution leak"),
    "water-leak": ("water_leak", "Hyphenated alias for water leak"),
    "water_leakage": ("water_leak", "Colloquial water leakage alias"),
    "pipe_burst": ("water_leak", "Burst water supply pipe / surface pooling"),
    "damaged_borewell": ("water_leak", "Damaged municipal borewell with surface pooling"),

    # Sewage / Drainage mappings
    "sewage": ("sewage", "Direct category match for sewage overflow / contaminated discharge"),
    "sewage_overflow": ("sewage", "Open sewer / manhole sewage overflow"),
    "blocked_drain": ("sewage", "Blocked drainage system / storm drain overflow"),
    "blocked-drain": ("sewage", "Blocked drainage system / storm drain overflow"),
    "no_drainage": ("sewage", "Drainage failure / stagnant wastewater"),
    "no-drainage": ("sewage", "Drainage failure / stagnant wastewater"),
    "drainage": ("sewage", "General drainage defect"),

    # Traffic Signal mappings
    "traffic_signal": ("traffic_signal", "Direct category match for municipal traffic light defect"),
    "traffic-signal": ("traffic_signal", "Hyphenated alias for traffic signal"),
    "traffic_light": ("traffic_signal", "Traffic light alias"),
    "broken_signal": ("traffic_signal", "Broken / malfunctioning traffic signal"),

    # Explicit Non-defect / Background 'other' mappings
    "other": ("other", "Explicit non-defect urban background sample"),
    "normal": ("other", "Explicit non-defect normal condition"),
    "normal_road": ("other", "Clean undamaged road surface (negative sample)"),
    "clean_road": ("other", "Clean undamaged road surface (negative sample)"),
    "background": ("other", "Verified non-defect urban background scene"),
    "non_defect": ("other", "Verified negative non-defect sample")
}

# Supported image binary magic signatures
IMAGE_SIGNATURES: Dict[str, bytes] = {
    "jpeg": b"\xFF\xD8\xFF",
    "png": b"\x89\x50\x4E\x47\x0D\x0A\x1A\x0A",
    "webp_riff": b"\x52\x49\x46\x46" # WEBP prefix at byte 0-3
}

# -----------------------------------------------------------------------------
# Image Integrity & Validation Utilities
# -----------------------------------------------------------------------------

def validate_image(
    image_path: Path,
    min_width: int = 32,
    min_height: int = 32,
    max_file_size_bytes: int = 25 * 1024 * 1024
) -> Tuple[bool, Optional[str], Optional[Tuple[int, int]]]:
    """
    Validates an image file by checking physical existence, size limits,
    binary magic bytes signature, and PIL decodability.

    Returns:
        (is_valid: bool, error_message: Optional[str], dimensions: Optional[Tuple[int, int]])
    """
    if not image_path.exists() or not image_path.is_file():
        return False, f"File does not exist: {image_path}", None

    file_size = image_path.stat().st_size
    if file_size == 0:
        return False, "File is zero bytes (empty)", None

    if file_size > max_file_size_bytes:
        return False, f"File size {file_size} exceeds maximum limit {max_file_size_bytes} bytes", None

    # Magic byte check
    try:
        with open(image_path, "rb") as f:
            header = f.read(16)
    except Exception as e:
        return False, f"Could not read file header: {e}", None

    is_jpeg = header.startswith(IMAGE_SIGNATURES["jpeg"])
    is_png = header.startswith(IMAGE_SIGNATURES["png"])
    is_webp = header.startswith(IMAGE_SIGNATURES["webp_riff"]) and len(header) >= 12 and header[8:12] == b"\x57\x45\x42\x50"

    if not (is_jpeg or is_png or is_webp):
        return False, f"Invalid binary signature. Header does not match JPEG, PNG, or WebP: {header[:8].hex()}", None

    # PIL decode verification
    try:
        with Image.open(image_path) as img:
            img.verify()
            width, height = img.size
    except (UnidentifiedImageError, OSError, SyntaxError) as e:
        return False, f"Corrupt or unreadable image: {e}", None
    except Exception as e:
        return False, f"Unexpected error decoding image: {e}", None

    if width < min_width or height < min_height:
        return False, f"Image dimensions ({width}x{height}) are smaller than minimum allowed ({min_width}x{min_height})", None

    return True, None, (width, height)


def compute_sha256(file_path: Path) -> str:
    """Computes SHA-256 hash of a file for exact duplicate detection."""
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            sha.update(chunk)
    return sha.hexdigest()


def compute_average_hash(image_path: Path, hash_size: int = 8) -> Optional[str]:
    """
    Computes an 8x8 average perceptual hash for near-duplicate screening.
    Returns 16-character hex string or None if image fails to decode.
    """
    try:
        with Image.open(image_path) as img:
            img_gray = img.convert("L").resize((hash_size, hash_size), Image.Resampling.LANCZOS)
            if hasattr(img_gray, "get_flattened_data"):
                pixels = list(img_gray.get_flattened_data())
            else:
                pixels = list(img_gray.getdata())
            avg = sum(pixels) / len(pixels)
            bits = "".join(["1" if p > avg else "0" for p in pixels])
            return f"{int(bits, 2):0{hash_size * hash_size // 4}x}"
    except Exception:
        return None

# -----------------------------------------------------------------------------
# Defensible Label Mapping
# -----------------------------------------------------------------------------

def map_label_to_canonical(raw_label: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Maps an arbitrary raw source label to one of the 8 canonical categories.
    Strict rule: If the label is unsupported or ambiguous, returns (None, reason).
    NEVER silently assigns unsupported classes to 'other'.

    Returns:
        (canonical_category: Optional[str], rationale_or_rejection_reason: str)
    """
    if not raw_label or not isinstance(raw_label, str):
        return None, "Empty or non-string label provided"

    normalized = raw_label.strip().lower().replace(" ", "_")

    if normalized in LABEL_MAPPING_RULES:
        category, rationale = LABEL_MAPPING_RULES[normalized]
        return category, rationale

    return None, f"Unsupported class '{raw_label}'. No defensible mapping to canonical categories."

# -----------------------------------------------------------------------------
# Annotation Parsers: Pascal VOC & COCO JSON & ImageFolder
# -----------------------------------------------------------------------------

def parse_voc_xml(xml_path: Path) -> Tuple[bool, Optional[Dict[str, Any]], Optional[str]]:
    """
    Parses a Pascal VOC format XML annotation file.
    Extracts filename, dimensions, and bounding boxes.
    """
    if not xml_path.exists():
        return False, None, f"XML file not found: {xml_path}"

    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        return False, None, f"Malformed XML: {e}"

    filename_elem = root.find("filename")
    filename = filename_elem.text.strip() if filename_elem is not None and filename_elem.text else xml_path.stem + ".jpg"

    size_elem = root.find("size")
    width, height = None, None
    if size_elem is not None:
        try:
            w_text = size_elem.findtext("width")
            h_text = size_elem.findtext("height")
            if w_text and h_text:
                width, height = int(w_text), int(h_text)
        except (ValueError, TypeError):
            pass

    objects = []
    for obj in root.findall("object"):
        name_elem = obj.find("name")
        if name_elem is None or not name_elem.text:
            continue
        raw_name = name_elem.text.strip()

        bndbox = obj.find("bndbox")
        bbox = None
        if bndbox is not None:
            try:
                xmin = float(bndbox.findtext("xmin", "0"))
                ymin = float(bndbox.findtext("ymin", "0"))
                xmax = float(bndbox.findtext("xmax", "0"))
                ymax = float(bndbox.findtext("ymax", "0"))
                if xmax > xmin and ymax > ymin:
                    bbox = [int(round(xmin)), int(round(ymin)), int(round(xmax)), int(round(ymax))]
            except (ValueError, TypeError):
                bbox = None

        canonical_cat, reason = map_label_to_canonical(raw_name)
        objects.append({
            "original_label": raw_name,
            "mapped_category": canonical_cat,
            "mapping_status": "mapped" if canonical_cat else "unmapped",
            "mapping_reason": reason,
            "bbox": bbox
        })

    return True, {
        "filename": filename,
        "width": width,
        "height": height,
        "objects": objects
    }, None


def parse_coco_json(json_path: Path) -> Tuple[bool, Optional[Dict[str, Any]], Optional[str]]:
    """
    Parses a COCO format JSON annotation file.
    Extracts images, categories, and bounding boxes.
    """
    if not json_path.exists():
        return False, None, f"JSON file not found: {json_path}"

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return False, None, f"Malformed COCO JSON: {e}"

    if not isinstance(data, dict):
        return False, None, "COCO root must be a JSON object"

    categories_raw = data.get("categories", [])
    images_raw = data.get("images", [])
    annotations_raw = data.get("annotations", [])

    category_id_map = {}
    for cat in categories_raw:
        cat_id = cat.get("id")
        cat_name = cat.get("name", "")
        if cat_id is not None:
            canonical_cat, reason = map_label_to_canonical(cat_name)
            category_id_map[cat_id] = {
                "original_label": cat_name,
                "mapped_category": canonical_cat,
                "mapping_status": "mapped" if canonical_cat else "unmapped",
                "mapping_reason": reason
            }

    # Group annotations by image_id
    image_annotations = {}
    for ann in annotations_raw:
        img_id = ann.get("image_id")
        if img_id not in image_annotations:
            image_annotations[img_id] = []
        cat_info = category_id_map.get(ann.get("category_id"), {
            "original_label": "unknown",
            "mapped_category": None,
            "mapping_status": "unmapped",
            "mapping_reason": "Unknown category ID"
        })
        bbox_xywh = ann.get("bbox") # [x, y, w, h]
        bbox_xyxy = None
        if bbox_xywh and len(bbox_xywh) == 4:
            x, y, w, h = bbox_xywh
            if w > 0 and h > 0:
                bbox_xyxy = [int(round(x)), int(round(y)), int(round(x + w)), int(round(y + h))]

        image_annotations[img_id].append({
            "original_label": cat_info["original_label"],
            "mapped_category": cat_info["mapped_category"],
            "mapping_status": cat_info["mapping_status"],
            "mapping_reason": cat_info["mapping_reason"],
            "bbox": bbox_xyxy
        })

    parsed_images = []
    for img in images_raw:
        img_id = img.get("id")
        file_name = img.get("file_name", "")
        parsed_images.append({
            "image_id": img_id,
            "filename": file_name,
            "width": img.get("width"),
            "height": img.get("height"),
            "objects": image_annotations.get(img_id, [])
        })

    return True, {
        "categories": category_id_map,
        "images": parsed_images
    }, None

# -----------------------------------------------------------------------------
# Group-Aware Stratified Splitting
# -----------------------------------------------------------------------------

def split_dataset_group_aware(
    records: List[Dict[str, Any]],
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
    test_ratio: float = 0.15,
    seed: int = 42
) -> List[Dict[str, Any]]:
    """
    Performs a deterministic, group-aware stratified train/val/test split.
    All records with the same group_id are guaranteed to land in the same split,
    even if the group contains bounding boxes with different classes.
    This strictly prevents data leakage from multi-crop bounding boxes or video sequences.

    Returns the updated records with a 'split' attribute ('train', 'val', 'test').
    """
    assert abs(train_ratio + val_ratio + test_ratio - 1.0) < 1e-5, "Split ratios must sum to 1.0"

    rng = random.Random(seed)

    # 1. Group records globally by group_id
    group_records: Dict[str, List[Dict[str, Any]]] = {}
    for rec in records:
        gid = str(rec.get("group_id") or rec.get("image_id") or rec.get("file_hash") or "unknown_group")
        if gid not in group_records:
            group_records[gid] = []
        group_records[gid].append(rec)

    # 2. Compute category frequency across records for rarest-first stratum assignment
    cat_counts: Dict[str, int] = {}
    for rec in records:
        c = rec.get("mapped_category")
        if c:
            cat_counts[c] = cat_counts.get(c, 0) + 1

    # 3. Assign each group to a primary stratum (prioritize rarer class for balanced representation)
    strata_groups: Dict[str, List[str]] = {}
    for gid, recs in group_records.items():
        cats_in_group = [r.get("mapped_category") for r in recs if r.get("mapped_category")]
        if cats_in_group:
            primary_cat = min(cats_in_group, key=lambda c: cat_counts.get(c, 0))
        else:
            primary_cat = "unmapped"

        if primary_cat not in strata_groups:
            strata_groups[primary_cat] = []
        strata_groups[primary_cat].append(gid)

    # 4. Deterministically partition each stratum into train, val, test
    group_split_map: Dict[str, str] = {}
    for cat in sorted(strata_groups.keys()):
        g_list = sorted(strata_groups[cat])
        rng.shuffle(g_list)

        total_samples = sum(len(group_records[g]) for g in g_list)
        target_train = int(round(total_samples * train_ratio))
        target_val = int(round(total_samples * val_ratio))

        curr_train = 0
        curr_val = 0

        for gid in g_list:
            count = len(group_records[gid])
            if curr_train + count <= target_train or (curr_train == 0 and target_train > 0):
                chosen_split = "train"
                curr_train += count
            elif curr_val + count <= target_val or (curr_val == 0 and target_val > 0):
                chosen_split = "val"
                curr_val += count
            else:
                chosen_split = "test"

            group_split_map[gid] = chosen_split

    # 5. Apply split atomically to all records based on group_id
    for rec in records:
        gid = str(rec.get("group_id") or rec.get("image_id") or rec.get("file_hash") or "unknown_group")
        rec["split"] = group_split_map.get(gid, "train")

    return records

# -----------------------------------------------------------------------------
# Manifest Generation Pipeline
# -----------------------------------------------------------------------------

def generate_manifest_from_directory(
    dataset_root: Path,
    dataset_type: str = "auto",
    source_name: str = "local_dataset",
    output_dir: Optional[Path] = None,
    crop_bboxes: bool = False,
    seed: int = 42
) -> Dict[str, Any]:
    """
    Scans a dataset directory, parses annotations, validates images, filters duplicates,
    performs group-aware splitting, and produces an auditable dataset manifest.

    dataset_type: 'voc_xml', 'coco_json', 'image_folder', or 'auto'
    """
    dataset_root = Path(dataset_root).resolve()
    if not dataset_root.exists() or not dataset_root.is_dir():
        raise FileNotFoundError(f"Dataset root directory does not exist: {dataset_root}")

    records = []
    seen_hashes: Set[str] = set()
    duplicate_records: List[Dict[str, Any]] = []
    corrupted_records: List[Dict[str, Any]] = []
    unmapped_records: List[Dict[str, Any]] = []

    # 1. Detection of dataset layout if auto
    has_xml = bool(list(dataset_root.glob("**/*.xml")))
    has_coco = bool(list(dataset_root.glob("**/annotations/*.json")) or list(dataset_root.glob("**/*coco*.json")))

    if dataset_type == "auto":
        if has_xml:
            dataset_type = "voc_xml"
        elif has_coco:
            dataset_type = "coco_json"
        else:
            dataset_type = "image_folder"

    # 2. Parsing loop
    if dataset_type == "voc_xml":
        xml_files = sorted(list(dataset_root.glob("**/*.xml")))
        for xml_file in xml_files:
            success, voc_data, err = parse_voc_xml(xml_file)
            if not success or not voc_data:
                corrupted_records.append({"source_file": str(xml_file), "error": err})
                continue

            # Locate corresponding image
            parent_dir = xml_file.parent
            candidate_names = [
                voc_data["filename"],
                xml_file.stem + ".jpg",
                xml_file.stem + ".png",
                xml_file.stem + ".jpeg",
                xml_file.stem + ".webp"
            ]
            img_path = None
            for cname in candidate_names:
                for probe in [
                    parent_dir / cname,
                    parent_dir.parent / "images" / cname,
                    parent_dir / "images" / cname,
                    parent_dir.parent.parent / "images" / cname,
                    parent_dir.parent / "JPEGImages" / cname,
                    parent_dir.parent.parent / "JPEGImages" / cname,
                    dataset_root / cname,
                    dataset_root / "images" / cname
                ]:
                    if probe.exists():
                        img_path = probe
                        break
                if img_path:
                    break

            if not img_path:
                corrupted_records.append({"source_file": str(xml_file), "error": "Image file not found for XML"})
                continue

            is_valid, img_err, dims = validate_image(img_path)
            if not is_valid:
                corrupted_records.append({"source_file": str(img_path), "error": img_err})
                continue

            f_hash = compute_sha256(img_path)
            if f_hash in seen_hashes:
                duplicate_records.append({"file": str(img_path), "hash": f_hash})
                continue
            seen_hashes.add(f_hash)

            # Group identity: Use parent image stem or sequence group prefix
            group_id = xml_file.stem

            # Process objects
            for obj_idx, obj in enumerate(voc_data.get("objects", [])):
                cat = obj.get("mapped_category")
                if not cat:
                    unmapped_records.append({
                        "file": str(img_path),
                        "original_label": obj.get("original_label"),
                        "reason": obj.get("mapping_reason")
                    })
                    continue

                sample_id = f"{group_id}_{obj_idx}"
                records.append({
                    "sample_id": sample_id,
                    "image_path": str(img_path.relative_to(dataset_root)),
                    "absolute_path": str(img_path),
                    "source_dataset": source_name,
                    "group_id": group_id,
                    "original_label": obj["original_label"],
                    "mapped_category": cat,
                    "mapping_reason": obj["mapping_reason"],
                    "bbox": obj.get("bbox"),
                    "width": dims[0] if dims else None,
                    "height": dims[1] if dims else None,
                    "file_hash": f_hash
                })

    elif dataset_type == "coco_json":
        coco_files = sorted(
            list(dataset_root.glob("**/annotations/*.json")) or
            list(dataset_root.glob("**/*coco*.json")) or
            list(dataset_root.glob("*.json"))
        )
        for cjson in coco_files:
            success, coco_data, err = parse_coco_json(cjson)
            if not success or not coco_data:
                corrupted_records.append({"source_file": str(cjson), "error": err})
                continue

            parent_dir = cjson.parent
            for img_info in coco_data.get("images", []):
                fname = img_info.get("filename", "")
                if not fname:
                    continue

                candidate_names = [fname, Path(fname).name]
                img_path = None
                for cname in candidate_names:
                    for probe in [
                        dataset_root / cname,
                        dataset_root / "images" / cname,
                        parent_dir / cname,
                        parent_dir.parent / "images" / cname,
                        parent_dir / "images" / cname
                    ]:
                        if probe.exists():
                            img_path = probe
                            break
                    if img_path:
                        break

                if not img_path:
                    corrupted_records.append({"source_file": str(cjson), "error": f"Image file not found: {fname}"})
                    continue

                is_valid, img_err, dims = validate_image(img_path)
                if not is_valid:
                    corrupted_records.append({"source_file": str(img_path), "error": img_err})
                    continue

                f_hash = compute_sha256(img_path)
                if f_hash in seen_hashes:
                    duplicate_records.append({"file": str(img_path), "hash": f_hash})
                    continue
                seen_hashes.add(f_hash)

                p_fname = Path(fname)
                group_id = f"{p_fname.parent.name}_{p_fname.stem}" if p_fname.parent.name and p_fname.parent.name != "." else p_fname.stem
                for obj_idx, obj in enumerate(img_info.get("objects", [])):
                    cat = obj.get("mapped_category")
                    if not cat:
                        unmapped_records.append({
                            "file": str(img_path),
                            "original_label": obj.get("original_label"),
                            "reason": obj.get("mapping_reason")
                        })
                        continue

                    sample_id = f"{group_id}_{obj_idx}"
                    records.append({
                        "sample_id": sample_id,
                        "image_path": str(img_path.relative_to(dataset_root)),
                        "absolute_path": str(img_path),
                        "source_dataset": source_name,
                        "group_id": group_id,
                        "original_label": obj["original_label"],
                        "mapped_category": cat,
                        "mapping_reason": obj["mapping_reason"],
                        "bbox": obj.get("bbox"),
                        "width": dims[0] if dims else None,
                        "height": dims[1] if dims else None,
                        "file_hash": f_hash
                    })

    elif dataset_type == "image_folder":
        # Standard directory per class: dataset_root/<class_name>/<images>
        image_extensions = {".jpg", ".jpeg", ".png", ".webp"}
        for entry in sorted(dataset_root.iterdir()):
            if not entry.is_dir():
                continue
            folder_name = entry.name
            canonical_cat, map_reason = map_label_to_canonical(folder_name)

            if not canonical_cat:
                unmapped_records.append({
                    "folder": str(entry),
                    "original_label": folder_name,
                    "reason": map_reason
                })
                continue

            for img_file in sorted(entry.iterdir()):
                if img_file.suffix.lower() not in image_extensions:
                    continue

                is_valid, img_err, dims = validate_image(img_file)
                if not is_valid:
                    corrupted_records.append({"source_file": str(img_file), "error": img_err})
                    continue

                f_hash = compute_sha256(img_file)
                if f_hash in seen_hashes:
                    duplicate_records.append({"file": str(img_file), "hash": f_hash})
                    continue
                seen_hashes.add(f_hash)

                # Sequence detection for group_id: e.g. photo123_01.jpg -> photo123
                stem = img_file.stem
                group_id = stem.split("_")[0] if "_" in stem else stem

                records.append({
                    "sample_id": stem,
                    "image_path": str(img_file.relative_to(dataset_root)),
                    "absolute_path": str(img_file),
                    "source_dataset": source_name,
                    "group_id": group_id,
                    "original_label": folder_name,
                    "mapped_category": canonical_cat,
                    "mapping_reason": map_reason,
                    "bbox": None,
                    "width": dims[0] if dims else None,
                    "height": dims[1] if dims else None,
                    "file_hash": f_hash
                })

    # 3. Perform group-aware stratified split
    split_dataset_group_aware(records, seed=seed)

    # 4. Generate summary stats
    class_counts = {cat: {"total": 0, "train": 0, "val": 0, "test": 0} for cat in CANONICAL_CATEGORIES}
    for r in records:
        cat = r["mapped_category"]
        s = r.get("split", "unassigned")
        if cat in class_counts:
            class_counts[cat]["total"] += 1
            if s in class_counts[cat]:
                class_counts[cat][s] += 1

    insufficient_classes = [cat for cat, stats in class_counts.items() if stats["total"] < 100]

    manifest = {
        "metadata": {
            "source_dataset": source_name,
            "dataset_type": dataset_type,
            "seed": seed,
            "total_samples": len(records),
            "duplicate_files_dropped": len(duplicate_records),
            "corrupt_files_dropped": len(corrupted_records),
            "unmapped_annotations_dropped": len(unmapped_records),
            "insufficient_classes_warning": insufficient_classes
        },
        "class_counts": class_counts,
        "samples": records
    }

    # 5. Write outputs if output_dir specified
    if output_dir:
        output_dir = Path(output_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)

        json_path = output_dir / "manifest.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

        csv_path = output_dir / "manifest.csv"
        fieldnames = [
            "sample_id", "mapped_category", "split", "source_dataset",
            "group_id", "original_label", "image_path", "width", "height", "file_hash"
        ]
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for r in records:
                writer.writerow(r)

    return manifest


def format_manifest_report(manifest: Dict[str, Any]) -> str:
    """Formats manifest statistics into a human-readable Markdown summary report."""
    meta = manifest["metadata"]
    counts = manifest["class_counts"]

    lines = [
        "## Dataset Manifest & Class Distribution Audit Report",
        f"- **Source Dataset**: {meta['source_dataset']}",
        f"- **Dataset Type**: {meta['dataset_type']}",
        f"- **Random Seed**: {meta['seed']}",
        f"- **Total Valid Samples**: {meta['total_samples']}",
        f"- **Duplicates Dropped**: {meta['duplicate_files_dropped']}",
        f"- **Corrupt Files Dropped**: {meta['corrupt_files_dropped']}",
        f"- **Unmapped Dropped**: {meta['unmapped_annotations_dropped']}",
        "",
        "### Class Distribution Table",
        "| Canonical Category | Total | Train (70%) | Val (15%) | Test (15%) | Training Feasibility |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |"
    ]

    for cat in CANONICAL_CATEGORIES:
        st = counts.get(cat, {"total": 0, "train": 0, "val": 0, "test": 0})
        total = st["total"]
        if total >= 250:
            status = "Ready (Abundant)"
        elif total >= 100:
            status = "Viable (Minimal)"
        elif total > 0:
            status = "Deficient (< 100)"
        else:
            status = "Empty (0 samples)"

        lines.append(f"| `{cat}` | {st['total']} | {st['train']} | {st['val']} | {st['test']} | {status} |")

    lines.append("")
    if meta.get("insufficient_classes_warning"):
        lines.append("### Deficient Categories Warning")
        for ic in meta["insufficient_classes_warning"]:
            c = counts[ic]["total"]
            lines.append(f"- `WARNING`: Category `{ic}` has only {c} samples (< 100 threshold).")

    return "\n".join(lines)


# -----------------------------------------------------------------------------
# CLI Entrypoint
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CivicVision AI Dataset Manifest Generator")
    parser.add_argument("--input-dir", required=True, help="Path to input dataset directory")
    parser.add_argument("--output-dir", required=False, default=None, help="Output directory to save manifest.json and manifest.csv")
    parser.add_argument("--dataset-type", choices=["auto", "voc_xml", "coco_json", "image_folder"], default="auto", help="Annotation layout")
    parser.add_argument("--source-name", default="local_dataset", help="Dataset identifier for provenance")
    parser.add_argument("--seed", type=int, default=42, help="Seed for reproducible train/val/test splitting")

    args = parser.parse_args()

    try:
        manifest_res = generate_manifest_from_directory(
            dataset_root=Path(args.input_dir),
            dataset_type=args.dataset_type,
            source_name=args.source_name,
            output_dir=Path(args.output_dir) if args.output_dir else None,
            seed=args.seed
        )
        print(format_manifest_report(manifest_res))
    except Exception as e:
        print(f"Error generating dataset manifest: {e}", file=sys.stderr)
        sys.exit(1)
