import io
import time
import zipfile
from pathlib import Path

def selective_extract():
    archive_path = Path("data/raw/archives/RDD2022_released_through_CRDDC2022.zip")
    output_dir = Path("data/raw/rdd2022")
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Opening outer archive: {archive_path}")
    t0 = time.time()
    with zipfile.ZipFile(archive_path, 'r') as outer_zip:
        for country, inner_zip_name in [("India", "RDD2022/India.zip"), ("Japan", "RDD2022/Japan.zip")]:
            country_t0 = time.time()
            print(f"\n--- Processing {country} from {inner_zip_name} ---")
            print(f"Reading inner zip stream for {country}...")
            inner_bytes = outer_zip.read(inner_zip_name)
            print(f"Inner zip read ({len(inner_bytes)} bytes). Extracting train images and annotations...")

            with zipfile.ZipFile(io.BytesIO(inner_bytes), 'r') as inner_zip:
                members = inner_zip.infolist()
                target_prefix = f"{country}/train/"
                targets = [m for m in members if m.filename.startswith(target_prefix) and not m.filename.endswith("/")]
                
                print(f"Discovered {len(targets)} {country}/train files to extract (skipping test & unannotated sets).")
                extracted_count = 0
                for info in targets:
                    inner_zip.extract(info, output_dir)
                    extracted_count += 1
                    if extracted_count % 5000 == 0:
                        print(f"  Extracted {extracted_count}/{len(targets)} {country} files...")

                print(f"Completed {country}: {extracted_count} files extracted in {round(time.time() - country_t0, 2)}s.")

    print(f"\nAll selective extractions completed in {round(time.time() - t0, 2)}s.")

if __name__ == "__main__":
    selective_extract()
