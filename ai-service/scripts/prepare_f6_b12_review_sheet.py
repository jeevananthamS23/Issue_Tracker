import os
import csv
import pandas as pd

def create_human_review_sheet():
    f6_b11_csv = "data/manifest_out/f6_b11/semantic_screening_results.csv"
    out_dir = "data/manifest_out/f6_b12"
    os.makedirs(out_dir, exist_ok=True)
    out_csv = os.path.join(out_dir, "pilot_human_review_sheet.csv")

    df = pd.read_csv(f6_b11_csv)
    assert len(df) == 50, f"Expected 50 records, found {len(df)}"

    review_rows = []
    for _, r in df.iterrows():
        review_rows.append({
            "candidate_id": r["candidate_id"],
            "sample_id": r["sample_id"],
            "group_id": r["group_id"],
            "existing_split": r["existing_split"],
            "relative_image_path": r["relative_image_path"],
            "absolute_image_path": r["absolute_image_path"],
            "file_hash": r["file_hash"],
            "heuristic_prediction": r["heuristic_classification"],
            "semantic_prediction": r["suggested_classification"],
            "semantic_top_class": r["top_detection_class"],
            "human_label": "",   # Strictly blank for human reviewer
            "reviewer_id": "",   # Strictly blank for human reviewer
            "review_date": "",   # Strictly blank for human reviewer
            "notes": ""          # Strictly blank for human reviewer
        })

    fieldnames = [
        "candidate_id",
        "sample_id",
        "group_id",
        "existing_split",
        "relative_image_path",
        "absolute_image_path",
        "file_hash",
        "heuristic_prediction",
        "semantic_prediction",
        "semantic_top_class",
        "human_label",
        "reviewer_id",
        "review_date",
        "notes"
    ]

    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(review_rows)

    print(f"Created {out_csv} with {len(review_rows)} rows. All human fields left blank.")

if __name__ == "__main__":
    create_human_review_sheet()
