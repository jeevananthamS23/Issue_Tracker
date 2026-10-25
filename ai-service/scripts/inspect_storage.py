import os
import shutil
from pathlib import Path

def get_dir_stats(path_str):
    p = Path(path_str)
    if not p.exists():
        return {
            'exists': False,
            'total_bytes': 0,
            'total_mb': 0,
            'total_gb': 0,
            'file_count': 0,
            'dir_count': 0,
            'largest_files': []
        }
    total_bytes = 0
    file_count = 0
    dir_count = 0
    files = []
    for root, dirs, filenames in os.walk(p):
        dir_count += len(dirs)
        for f in filenames:
            file_count += 1
            fp = Path(root) / f
            try:
                sz = fp.stat().st_size
                total_bytes += sz
                files.append((sz, str(fp)))
            except Exception:
                pass
    files.sort(key=lambda x: x[0], reverse=True)
    return {
        'exists': True,
        'total_bytes': total_bytes,
        'total_mb': round(total_bytes / (1024 * 1024), 2),
        'total_gb': round(total_bytes / (1024 * 1024 * 1024), 3),
        'file_count': file_count,
        'dir_count': dir_count,
        'largest_files': files[:5]
    }

def main():
    dirs_to_check = [
        'data/raw/archives',
        'data/raw/rdd2022',
        'data/raw/taco',
        'data/manifest_out/rdd2022',
        'data/manifest_out/taco'
    ]

    print("=== DIRECTORY INSPECTION ===")
    for d in dirs_to_check:
        stats = get_dir_stats(d)
        print(f"\nDirectory: {d}")
        print(f"  Exists: {stats['exists']}")
        print(f"  Total Size: {stats['total_bytes']:,} bytes ({stats['total_mb']:,} MB / {stats['total_gb']} GB)")
        print(f"  Files: {stats['file_count']}, Subdirs: {stats['dir_count']}")
        print("  Largest files:")
        for sz, fp in stats['largest_files']:
            print(f"    - {fp}: {sz:,} bytes ({round(sz / (1024 * 1024), 2)} MB)")

    total, used, free = shutil.disk_usage('.')
    print("\n=== DISK USAGE (Drive E:) ===")
    print(f"Total: {total:,} bytes ({round(total / (1024 ** 3), 2)} GB)")
    print(f"Used:  {used:,} bytes ({round(used / (1024 ** 3), 2)} GB)")
    print(f"Free:  {free:,} bytes ({round(free / (1024 ** 3), 2)} GB)")

if __name__ == '__main__':
    main()
