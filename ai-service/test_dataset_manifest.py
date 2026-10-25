"""
CivicVision AI — Dataset Preparation & Manifest Unit Tests (Phase F6-B1)

Verifies:
1. Annotation parsing: Pascal VOC XML and COCO JSON parsing.
2. Defensible category mapping: All 8 canonical classes mapped accurately.
3. Strict rejection of unsupported classes: Unknown classes are NOT silently mapped to 'other'.
4. Image integrity & validation: Zero-byte, non-existent, invalid signature, and corrupt files detected.
5. Content deduplication: SHA-256 exact match drops duplicate files.
6. Group-aware splitting: Multi-crop bounding boxes from the same parent image never leak across splits.
7. Split reproducibility: Fixed seed guarantees identical train/val/test splits.
8. Class imbalance audit & minimum sample warnings.
"""

import io
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image

from scripts.dataset_manifest import (
    CANONICAL_CATEGORIES,
    map_label_to_canonical,
    validate_image,
    compute_sha256,
    compute_average_hash,
    parse_voc_xml,
    parse_coco_json,
    split_dataset_group_aware,
    generate_manifest_from_directory,
    format_manifest_report
)


class TestDatasetManifest(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _create_synthetic_image(self, filename: str, width: int = 100, height: int = 100, color=None) -> Path:
        """Helper to create a valid PNG/JPEG file on disk."""
        path = self.root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        if color is None:
            # Deterministic distinct color per filename to prevent false-positive SHA256 duplicate matches
            name_bytes = filename.encode("utf-8")
            r = (sum(name_bytes) * 17) % 256
            g = (sum(name_bytes) * 31) % 256
            b = (sum(name_bytes) * 53) % 256
            color = (r, g, b)
        img = Image.new("RGB", (width, height), color=color)
        fmt = "JPEG" if path.suffix.lower() in [".jpg", ".jpeg"] else "PNG"
        img.save(path, format=fmt)
        return path

    # -------------------------------------------------------------------------
    # 1. Defensible Canonical Category Mapping
    # -------------------------------------------------------------------------

    def test_canonical_category_mappings(self):
        """All 8 canonical classes must be mapped with valid rationale."""
        for cat in CANONICAL_CATEGORIES:
            mapped, reason = map_label_to_canonical(cat)
            self.assertEqual(mapped, cat)
            self.assertTrue(len(reason) > 0)

    def test_source_aliases_mapped_defensibly(self):
        """Specific domain aliases must map to intended canonical categories."""
        # RDD2022 codes
        self.assertEqual(map_label_to_canonical("D40")[0], "pothole")
        self.assertEqual(map_label_to_canonical("D00")[0], "road_damage")
        self.assertEqual(map_label_to_canonical("D10")[0], "road_damage")
        self.assertEqual(map_label_to_canonical("D20")[0], "road_damage")

        # Waste / Litter
        self.assertEqual(map_label_to_canonical("trash")[0], "garbage")
        self.assertEqual(map_label_to_canonical("litter")[0], "garbage")
        self.assertEqual(map_label_to_canonical("plastic_bag")[0], "garbage")

        # Lighting & Signals
        self.assertEqual(map_label_to_canonical("street_light_out")[0], "street_light")
        self.assertEqual(map_label_to_canonical("traffic_light")[0], "traffic_signal")

        # Water & Sewage
        self.assertEqual(map_label_to_canonical("pipe_burst")[0], "water_leak")
        self.assertEqual(map_label_to_canonical("blocked_drain")[0], "sewage")

    def test_unsupported_classes_strictly_rejected(self):
        """Unsupported classes must NOT be silently assigned to 'other'."""
        unsupported = ["car", "person", "dog", "building", "tree", "D30", "bicycle", "unknown_tag"]
        for label in unsupported:
            mapped, reason = map_label_to_canonical(label)
            self.assertIsNone(mapped, f"Unsupported class '{label}' should return None, but was mapped to '{mapped}'")
            self.assertIn("Unsupported class", reason)

    # -------------------------------------------------------------------------
    # 2. Image Validation & Integrity
    # -------------------------------------------------------------------------

    def test_validate_valid_images(self):
        """Valid JPEG and PNG images must pass validation with correct dimensions."""
        jpg_path = self._create_synthetic_image("test.jpg", 128, 128, color="green")
        is_valid, err, dims = validate_image(jpg_path)
        self.assertTrue(is_valid)
        self.assertIsNone(err)
        self.assertEqual(dims, (128, 128))

        png_path = self._create_synthetic_image("test.png", 64, 48, color="yellow")
        is_valid, err, dims = validate_image(png_path)
        self.assertTrue(is_valid)
        self.assertEqual(dims, (64, 48))

    def test_validate_nonexistent_and_zero_byte(self):
        """Nonexistent and zero-byte files must be rejected."""
        is_valid, err, _ = validate_image(self.root / "does_not_exist.jpg")
        self.assertFalse(is_valid)
        self.assertIn("does not exist", err)

        empty_path = self.root / "empty.jpg"
        empty_path.write_bytes(b"")
        is_valid, err, _ = validate_image(empty_path)
        self.assertFalse(is_valid)
        self.assertIn("zero bytes", err)

    def test_validate_corrupt_binary_signature(self):
        """Text files or corrupted headers disguised as .jpg must be rejected."""
        fake_jpg = self.root / "corrupted.jpg"
        fake_jpg.write_text("THIS IS NOT A REAL JPEG IMAGE FILE")
        is_valid, err, _ = validate_image(fake_jpg)
        self.assertFalse(is_valid)
        self.assertIn("Invalid binary signature", err)

    def test_validate_undersized_images(self):
        """Images smaller than minimum dimensions must be flagged."""
        tiny_path = self._create_synthetic_image("tiny.png", 16, 16)
        is_valid, err, _ = validate_image(tiny_path, min_width=32, min_height=32)
        self.assertFalse(is_valid)
        self.assertIn("smaller than minimum", err)

    # -------------------------------------------------------------------------
    # 3. Deduplication: Content Hashing & Perceptual Hash
    # -------------------------------------------------------------------------

    def test_sha256_duplicate_detection(self):
        """Identical file contents produce matching hashes."""
        img1 = self._create_synthetic_image("img1.png", 64, 64, color="red")
        img2 = self.root / "img2.png"
        img2.write_bytes(img1.read_bytes())

        hash1 = compute_sha256(img1)
        hash2 = compute_sha256(img2)
        self.assertEqual(hash1, hash2)

    def test_average_perceptual_hash(self):
        """Perceptual average hash returns 16-hex character string."""
        img = self._create_synthetic_image("phash.png", 64, 64, color="blue")
        phash = compute_average_hash(img)
        self.assertIsNotNone(phash)
        self.assertEqual(len(phash), 16)

    # -------------------------------------------------------------------------
    # 4. Pascal VOC XML Parsing
    # -------------------------------------------------------------------------

    def test_parse_voc_xml_valid(self):
        """Parses valid Pascal VOC XML with bounding box coordinates."""
        xml_content = """<annotation>
            <filename>road_sample_01.jpg</filename>
            <size>
                <width>640</width>
                <height>480</height>
                <depth>3</depth>
            </size>
            <object>
                <name>D40</name>
                <bndbox>
                    <xmin>100</xmin>
                    <ymin>150</ymin>
                    <xmax>250</xmax>
                    <ymax>300</ymax>
                </bndbox>
            </object>
            <object>
                <name>D00</name>
                <bndbox>
                    <xmin>300</xmin>
                    <ymin>200</ymin>
                    <xmax>450</xmax>
                    <ymax>350</ymax>
                </bndbox>
            </object>
        </annotation>"""
        xml_path = self.root / "road_sample_01.xml"
        xml_path.write_text(xml_content, encoding="utf-8")

        success, data, err = parse_voc_xml(xml_path)
        self.assertTrue(success)
        self.assertIsNone(err)
        self.assertEqual(data["filename"], "road_sample_01.jpg")
        self.assertEqual(data["width"], 640)
        self.assertEqual(data["height"], 480)
        self.assertEqual(len(data["objects"]), 2)

        obj1 = data["objects"][0]
        self.assertEqual(obj1["original_label"], "D40")
        self.assertEqual(obj1["mapped_category"], "pothole")
        self.assertEqual(obj1["bbox"], [100, 150, 250, 300])

        obj2 = data["objects"][1]
        self.assertEqual(obj2["original_label"], "D00")
        self.assertEqual(obj2["mapped_category"], "road_damage")

    def test_parse_voc_xml_malformed(self):
        """Malformed XML syntax returns clean failure without unhandled exception."""
        bad_xml = self.root / "bad.xml"
        bad_xml.write_text("<annotation><unclosed_tag>", encoding="utf-8")
        success, data, err = parse_voc_xml(bad_xml)
        self.assertFalse(success)
        self.assertIsNone(data)
        self.assertIn("Malformed XML", err)

    # -------------------------------------------------------------------------
    # 5. COCO JSON Parsing
    # -------------------------------------------------------------------------

    def test_parse_coco_json_valid(self):
        """Parses COCO JSON with image definitions and annotations."""
        coco_data = {
            "categories": [
                {"id": 1, "name": "bottle", "supercategory": "plastic"},
                {"id": 2, "name": "unknown_item", "supercategory": "none"}
            ],
            "images": [
                {"id": 101, "file_name": "litter_01.jpg", "width": 800, "height": 600}
            ],
            "annotations": [
                {"id": 1, "image_id": 101, "category_id": 1, "bbox": [50, 60, 100, 150]},
                {"id": 2, "image_id": 101, "category_id": 2, "bbox": [200, 250, 80, 90]}
            ]
        }
        json_path = self.root / "coco_sample.json"
        json_path.write_text(json.dumps(coco_data), encoding="utf-8")

        success, data, err = parse_coco_json(json_path)
        self.assertTrue(success)
        self.assertIsNone(err)

        img = data["images"][0]
        self.assertEqual(img["filename"], "litter_01.jpg")
        self.assertEqual(len(img["objects"]), 2)

        # Mapped object
        ann1 = img["objects"][0]
        self.assertEqual(ann1["original_label"], "bottle")
        self.assertEqual(ann1["mapped_category"], "garbage")
        self.assertEqual(ann1["bbox"], [50, 60, 150, 210]) # converted to xyxy

        # Unmapped object
        ann2 = img["objects"][1]
        self.assertEqual(ann2["original_label"], "unknown_item")
        self.assertIsNone(ann2["mapped_category"])

    # -------------------------------------------------------------------------
    # 6. Group-Aware Stratified Splitting & Leakage Prevention
    # -------------------------------------------------------------------------

    def test_group_aware_split_no_leakage(self):
        """All bounding-box crops from the same parent image must land in the same split."""
        records = []
        # Create 10 source images, each with 3 bounding box crops
        for img_idx in range(10):
            gid = f"parent_img_{img_idx}"
            for crop_idx in range(3):
                records.append({
                    "sample_id": f"{gid}_crop_{crop_idx}",
                    "group_id": gid,
                    "mapped_category": "pothole"
                })

        split_dataset_group_aware(records, train_ratio=0.7, val_ratio=0.15, test_ratio=0.15, seed=42)

        # Check every group_id has records in exactly ONE split
        group_splits = {}
        for r in records:
            gid = r["group_id"]
            s = r["split"]
            if gid not in group_splits:
                group_splits[gid] = set()
            group_splits[gid].add(s)

        for gid, splits in group_splits.items():
            self.assertEqual(len(splits), 1, f"Group {gid} leaked across multiple splits: {splits}")

    def test_split_reproducibility(self):
        """Splits must be deterministic when using the same random seed."""
        records1 = [{"sample_id": f"s_{i}", "group_id": f"g_{i}", "mapped_category": "garbage"} for i in range(20)]
        records2 = [{"sample_id": f"s_{i}", "group_id": f"g_{i}", "mapped_category": "garbage"} for i in range(20)]

        split_dataset_group_aware(records1, seed=123)
        split_dataset_group_aware(records2, seed=123)

        splits1 = [r["split"] for r in records1]
        splits2 = [r["split"] for r in records2]
        self.assertEqual(splits1, splits2)

    # -------------------------------------------------------------------------
    # 7. End-to-End Directory Manifest Generation & Audit Report
    # -------------------------------------------------------------------------

    def test_generate_manifest_image_folder(self):
        """Scans ImageFolder structure, generates JSON/CSV manifests, and audits class counts."""
        dataset_dir = self.root / "civic_dataset"
        out_dir = self.root / "manifest_out"

        # Create sample structure for pothole and garbage
        for i in range(5):
            self._create_synthetic_image(f"civic_dataset/pothole/pothole_{i}.jpg", 64, 64)
        for i in range(3):
            self._create_synthetic_image(f"civic_dataset/garbage/litter_{i}.png", 64, 64)
        # Create unmapped folder
        self._create_synthetic_image("civic_dataset/random_folder/ignore_me.jpg", 64, 64)

        manifest = generate_manifest_from_directory(
            dataset_root=dataset_dir,
            dataset_type="image_folder",
            source_name="test_dataset",
            output_dir=out_dir,
            seed=42
        )

        self.assertEqual(manifest["metadata"]["total_samples"], 8)
        self.assertEqual(manifest["metadata"]["unmapped_annotations_dropped"], 1)
        self.assertEqual(manifest["class_counts"]["pothole"]["total"], 5)
        self.assertEqual(manifest["class_counts"]["garbage"]["total"], 3)

        # Verify output files exist
        self.assertTrue((out_dir / "manifest.json").exists())
        self.assertTrue((out_dir / "manifest.csv").exists())

        # Verify Markdown report formatting
        report = format_manifest_report(manifest)
        self.assertIn("Dataset Manifest & Class Distribution Audit Report", report)
        self.assertIn("WARNING", report) # Categories have < 100 samples

    def test_generate_manifest_coco_json(self):
        """Scans COCO JSON directory, produces manifest, and assigns splits properly."""
        dataset_dir = self.root / "coco_civic"
        out_dir = self.root / "coco_manifest_out"

        img1 = self._create_synthetic_image("coco_civic/images/bottle.jpg", 128, 128)
        img2 = self._create_synthetic_image("coco_civic/images/light.png", 128, 128)

        coco_data = {
            "categories": [
                {"id": 1, "name": "plastic_bottle"},
                {"id": 2, "name": "lamp_post"},
                {"id": 99, "name": "pedestrian"}
            ],
            "images": [
                {"id": 101, "file_name": "images/bottle.jpg", "width": 128, "height": 128},
                {"id": 102, "file_name": "images/light.png", "width": 128, "height": 128}
            ],
            "annotations": [
                {"id": 1, "image_id": 101, "category_id": 1, "bbox": [10, 10, 40, 40]},
                {"id": 2, "image_id": 101, "category_id": 99, "bbox": [60, 60, 30, 30]}, # unmapped pedestrian
                {"id": 3, "image_id": 102, "category_id": 2, "bbox": [20, 20, 50, 80]}
            ]
        }
        ann_dir = dataset_dir / "annotations"
        ann_dir.mkdir(parents=True, exist_ok=True)
        (ann_dir / "instances.json").write_text(json.dumps(coco_data), encoding="utf-8")

        manifest = generate_manifest_from_directory(
            dataset_root=dataset_dir,
            dataset_type="coco_json",
            source_name="test_coco",
            output_dir=out_dir,
            seed=42
        )

        self.assertEqual(manifest["metadata"]["total_samples"], 2)
        self.assertEqual(manifest["metadata"]["unmapped_annotations_dropped"], 1)
        self.assertEqual(manifest["class_counts"]["garbage"]["total"], 1)
        self.assertEqual(manifest["class_counts"]["street_light"]["total"], 1)
        self.assertTrue((out_dir / "manifest.json").exists())

    def test_generate_manifest_voc_xml(self):
        """Scans Pascal VOC XML directory, matches images, produces manifest."""
        dataset_dir = self.root / "voc_civic"
        out_dir = self.root / "voc_manifest_out"

        self._create_synthetic_image("voc_civic/images/road1.jpg", 100, 100)
        xml_content = """<annotation>
            <filename>road1.jpg</filename>
            <size><width>100</width><height>100</height><depth>3</depth></size>
            <object>
                <name>D40</name>
                <bndbox><xmin>10</xmin><ymin>10</ymin><xmax>50</xmax><ymax>50</ymax></bndbox>
            </object>
            <object>
                <name>D00</name>
                <bndbox><xmin>55</xmin><ymin>55</ymin><xmax>90</xmax><ymax>90</ymax></bndbox>
            </object>
        </annotation>"""
        xml_dir = dataset_dir / "annotations"
        xml_dir.mkdir(parents=True, exist_ok=True)
        (xml_dir / "road1.xml").write_text(xml_content, encoding="utf-8")

        manifest = generate_manifest_from_directory(
            dataset_root=dataset_dir,
            dataset_type="voc_xml",
            source_name="test_voc",
            output_dir=out_dir,
            seed=42
        )

        self.assertEqual(manifest["metadata"]["total_samples"], 2)
        self.assertEqual(manifest["class_counts"]["pothole"]["total"], 1)
        self.assertEqual(manifest["class_counts"]["road_damage"]["total"], 1)
        self.assertTrue((out_dir / "manifest.json").exists())
        self.assertTrue((out_dir / "manifest.csv").exists())

    def test_group_aware_split_multi_class_no_leakage(self):
        """Images containing multiple objects of DIFFERENT canonical classes must never leak across splits."""
        records = [
            {"sample_id": "img0_crop0", "group_id": "img_0", "mapped_category": "pothole"},
            {"sample_id": "img0_crop1", "group_id": "img_0", "mapped_category": "road_damage"},
            {"sample_id": "img1_crop0", "group_id": "img_1", "mapped_category": "pothole"},
            {"sample_id": "img2_crop0", "group_id": "img_2", "mapped_category": "road_damage"},
            {"sample_id": "img3_crop0", "group_id": "img_3", "mapped_category": "pothole"},
            {"sample_id": "img4_crop0", "group_id": "img_4", "mapped_category": "road_damage"},
            {"sample_id": "img5_crop0", "group_id": "img_5", "mapped_category": "garbage"},
            {"sample_id": "img5_crop1", "group_id": "img_5", "mapped_category": "traffic_signal"},
        ]

        split_dataset_group_aware(records, train_ratio=0.7, val_ratio=0.15, test_ratio=0.15, seed=42)

        # Confirm that every group_id has records in exactly ONE split
        group_to_splits = {}
        for r in records:
            gid = r["group_id"]
            if gid not in group_to_splits:
                group_to_splits[gid] = set()
            group_to_splits[gid].add(r["split"])

        for gid, splits in group_to_splits.items():
            self.assertEqual(len(splits), 1, f"Group {gid} leaked across multiple splits: {splits}")

    def test_generate_manifest_voc_nested_rdd_layout(self):
        """Scans RDD2022-style nested VOC directory (e.g. India/train/annotations/xmls and India/train/images)."""
        dataset_dir = self.root / "rdd_nested"
        out_dir = self.root / "rdd_nested_manifest_out"

        self._create_synthetic_image("rdd_nested/India/train/images/India_000001.jpg", 120, 120)
        xml_content = """<annotation>
            <filename>India_000001.jpg</filename>
            <size><width>120</width><height>120</height><depth>3</depth></size>
            <object>
                <name>D40</name>
                <bndbox><xmin>15</xmin><ymin>20</ymin><xmax>60</xmax><ymax>70</ymax></bndbox>
            </object>
            <object>
                <name>D00</name>
                <bndbox><xmin>70</xmin><ymin>80</ymin><xmax>110</xmax><ymax>115</ymax></bndbox>
            </object>
        </annotation>"""
        xml_dir = dataset_dir / "India" / "train" / "annotations" / "xmls"
        xml_dir.mkdir(parents=True, exist_ok=True)
        (xml_dir / "India_000001.xml").write_text(xml_content, encoding="utf-8")

        manifest = generate_manifest_from_directory(
            dataset_root=dataset_dir,
            dataset_type="voc_xml",
            source_name="rdd2022_india",
            output_dir=out_dir,
            seed=42
        )

        self.assertEqual(manifest["metadata"]["total_samples"], 2)
        self.assertEqual(manifest["class_counts"]["pothole"]["total"], 1)
        self.assertEqual(manifest["class_counts"]["road_damage"]["total"], 1)
        self.assertTrue((out_dir / "manifest.json").exists())
        self.assertTrue((out_dir / "manifest.csv").exists())


if __name__ == "__main__":
    unittest.main()


