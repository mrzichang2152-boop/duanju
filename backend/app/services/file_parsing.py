from __future__ import annotations
import io
from typing import Optional

def read_file_content(file_content: bytes, filename: str) -> str:
    """
    Reads file content based on extension.
    Supports .txt, .md, .docx, .pdf
    """
    filename_lower = filename.lower()
    
    if filename_lower.endswith(".txt") or filename_lower.endswith(".md"):
        return file_content.decode("utf-8", errors="ignore")
    
    elif filename_lower.endswith(".docx"):
        import docx
        doc = docx.Document(io.BytesIO(file_content))
        return "\n".join([para.text for para in doc.paragraphs])
        
    elif filename_lower.endswith(".pdf"):
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(file_content))
        text = []
        for page in reader.pages:
            text.append(page.extract_text())
        return "\n".join(text)
        
    else:
        # Try as text default
        return file_content.decode("utf-8", errors="ignore")
