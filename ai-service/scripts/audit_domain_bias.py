import json
from pathlib import Path
from collections import Counter

def audit_domain_characteristics():
    manifest_p = Path("data/manifest_out/f6_b6/multilabel_manifest.json")
    with open(manifest_p, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    samples = data["samples"]
    print("=== TASK 4: CROSS-DATASET DOMAIN BIAS AUDIT ===")
    
    by_source = {"RDD2022": [], "TACO": []}
    for s in samples:
        by_source[s["source"]].append(s)
        
    for src, slist in by_source.items():
        print(f"\n--- Domain Metrics for {src} ({len(slist):,} images) ---")
        resolutions = Counter((s["width"], s["height"]) for s in slist)
        aspect_ratios = Counter(round(s["width"] / s["height"], 2) if s["height"] else 0 for s in slist)
        megapixels = [round((s["width"] * s["height"]) / 1_000_000, 2) for s in slist if s["width"] and s["height"]]
        
        print(f"Top 5 Dimensions (W x H):")
        for dim, cnt in resolutions.most_common(5):
            print(f"  {dim[0]} x {dim[1]}: {cnt:,} images ({round(cnt/len(slist)*100, 1)}%)")
            
        print(f"Top 5 Aspect Ratios (W / H):")
        for ar, cnt in aspect_ratios.most_common(5):
            print(f"  Ratio {ar}: {cnt:,} images ({round(cnt/len(slist)*100, 1)}%)")
            
        avg_mp = round(sum(megapixels)/len(megapixels), 2)
        min_mp = min(megapixels)
        max_mp = max(megapixels)
        print(f"Resolution (Megapixels): Mean={avg_mp} MP, Min={min_mp} MP, Max={max_mp} MP")

if __name__ == "__main__":
    audit_domain_characteristics()
