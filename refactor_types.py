import os
import re

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

def refactor_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Add Optional, Union to imports
    if "from typing import Optional" not in content:
        if "from typing import " in content:
            content = re.sub(r"from typing import (.*)", r"from typing import Optional, Union, \1", content)
        else:
            content = "from typing import Optional, Union\n" + content

    # Fix Mapped[str | None] -> Mapped[Optional[str]]
    content = re.sub(r"Mapped\[(.*?) \| None\]", r"Mapped[Optional[\1]]", content)

    # Fix str | dict[str, Any] | None -> Optional[Union[str, dict[str, Any]]]
    # Specific case in linkapi.py
    content = content.replace("str | dict[str, Any] | None", "Optional[Union[str, dict[str, Any]]]")

    # Fix generic Type | None -> Optional[Type]
    # We iterate to handle overlapping or multiple occurrences
    # Regex to match: (Type) | None
    # Type can be: \w+, \w+\[.*\], "..."
    # We use a loop to replace all occurrences
    
    # Pattern 1: Simple word type: str | None
    content = re.sub(r"\b(\w+) \| None\b", r"Optional[\1]", content)

    # Pattern 2: Generic type: List[str] | None or dict[str, Any] | None
    # This is hard to match perfectly with regex due to nested brackets.
    # We can try a few common ones.
    content = re.sub(r"\b(dict\[[^\]]+\]) \| None", r"Optional[\1]", content)
    content = re.sub(r"\b(list\[[^\]]+\]) \| None", r"Optional[\1]", content)
    
    # Pattern 3: already processed Optional[...] | None ?? No, | None should be gone.
    
    # Pattern 4: A | B | None -> Optional[Union[A, B]]
    # Handle specific cases found in grep
    # str | dict[str, Any] | None handled above.

    # Any remaining | None
    # httpx.HTTPError | None
    content = re.sub(r"([\w\.]+) \| None", r"Optional[\1]", content)

    with open(filepath, 'w') as f:
        f.write(content)

if __name__ == "__main__":
    for f in files:
        path = os.path.abspath(f)
        if os.path.exists(path):
            print(f"Refactoring {path}")
            refactor_file(path)
        else:
            print(f"File not found: {path}")
