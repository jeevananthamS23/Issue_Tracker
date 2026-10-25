import json
from pathlib import Path
from collections import defaultdict, Counter

def audit_duplicates_and_splits():
    manifest_p = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
    with open(manifest_p, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    samples = data["samples"]
    print(f"=== TASK 3: DUPLICATE & SPLIT ISOLATION AUDIT ===")
    print(f"Total samples: {len(samples):,}")
    
    # 1. SHA-256 duplicates
    hash_to_samples = defaultdict(list)
    for s in samples:
        h = s.get("file_hash")
        assert h is not None and len(h) == 64
        hash_to_samples[h].append(s)
        
    exact_duplicates = {h: slist for h, slist in hash_to_samples.items() if len(slist) > 1}
    print(f"\n1. Exact SHA-256 Duplicates:")
    print(f"   Unique hashes: {len(hash_to_samples):,} / {len(samples):,}")
    print(f"   Exact duplicate hashes: {len(exact_duplicates)}")
    assert len(exact_duplicates) == 0, f"Found exact duplicates: {exact_duplicates}"
    
    # 2. Group ID and Split Isolation
    group_to_splits = defaultdict(set)
    group_to_samples = defaultdict(list)
    for s in samples:
        gid = s["group_id"]
        sp = s["split"]
        group_to_splits[gid].add(sp)
        group_to_samples[gid].append(s)
        
    print(f"\n2. Group ID and Split Isolation:")
    print(f"   Total unique group IDs: {len(group_to_splits):,}")
    split_leakage = {gid: splits for gid, splits in group_to_splits.items() if len(splits) > 1}
    print(f"   Groups crossing multiple splits: {len(split_leakage)}")
    assert len(split_leakage) == 0
    print("   Result: ZERO group-split leakage. Every sequence/image group is confined to exactly 1 split.")

    # 3. Source Sequence Group Structure in RDD2022
    # In RDD2022, consecutive numbers often come from the same drive (e.g. India_000004, India_000005)
    # Check split distribution across India vs Japan
    country_splits = Counter((s["image_path"].split("\\")[1] if "\\" in s["image_path"] else s["image_path"].split("/")[1], s["split"]) for s in samples if s["source"] == "RDD2022")
    print(f"\n3. RDD2022 Country x Split Distribution:")
    for (country, sp), cnt in sorted(country_splits.items()):
        print(f"   {country:10s} | {sp:5s}: {cnt:,} images")

    # 4. TACO Batch Distribution across Splits
    taco_batch_splits = Counter((s["image_path"].split("\\")[1] if "\\" in s["image_path"] else s["image_path"].split("/")[1], s["split"]) for s in samples if s["source"] == "TACO")
    print(f"\n4. TACO Batch Distribution across Splits (Sample):")
    for (batch, sp), cnt in sorted(taco_batch_splits.items())[:6]:
        print(f"   {batch:10s} | {sp:5s}: {cnt:,} images")

if __name__ == "__main__":
    audit_duplicates_and_splits()
