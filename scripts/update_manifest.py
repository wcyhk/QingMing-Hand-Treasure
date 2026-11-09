"""Refresh runtime checksums after intentional website changes, before committing."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
path = root / 'site-files.json'
manifest = json.loads(path.read_text(encoding='utf-8'))
for name in manifest:
    source = root / name
    if source.is_symlink() or not source.resolve().is_relative_to(root):
        raise ValueError('Unsafe runtime path: ' + name)
    manifest[name] = hashlib.sha256(source.read_bytes()).hexdigest()
path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(f'Updated {len(manifest)} runtime checksums; run scripts/build_site.py to verify.')
