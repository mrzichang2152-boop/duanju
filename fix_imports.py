import os

files = [
    "backend/app/schemas/script.py",
    "backend/app/services/linkapi.py",
    "backend/app/services/scripts.py",
    "backend/app/models/script.py",
    "backend/app/schemas/segments.py",
    "backend/app/models/segment_version.py",
    "backend/app/services/segments.py",
    "backend/app/schemas/settings.py",
    "backend/app/schemas/assets.py",
    "backend/app/models/prompt_template.py",
    "backend/app/services/assets.py",
    "backend/app/models/asset_version.py",
    "backend/app/models/asset.py",
    "backend/app/api/templates.py",
    "backend/app/models/settings.py",
    "backend/app/services/templates.py",
    "backend/app/services/settings.py",
    "backend/app/services/script_validation.py"
]

def fix_future_import(filepath):
    with open(filepath, 'r') as f:
        lines = f.readlines()

    # Find if future import exists
    future_line_idx = -1
    for i, line in enumerate(lines):
        if "from __future__ import annotations" in line:
            future_line_idx = i
            break
    
    if future_line_idx != -1:
        # Remove it from current position
        line = lines.pop(future_line_idx)
        # Insert at the beginning
        lines.insert(0, line)
        
        # Write back
        with open(filepath, 'w') as f:
            f.writelines(lines)
            print(f"Fixed {filepath}")
    else:
        # Add it if missing? No, only fix order if present.
        # But wait, we *need* it for type hinting in 3.9 if we use | 
        # Actually my refactor_types.py tried to remove | usage.
        # But some files might still have it or we want to be safe.
        # Let's just ensure it's at the top if present.
        pass

if __name__ == "__main__":
    for f in files:
        path = os.path.abspath(f)
        if os.path.exists(path):
            fix_future_import(path)
        else:
            print(f"File not found: {path}")
