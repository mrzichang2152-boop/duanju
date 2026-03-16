
import re
from typing import Optional

def _normalize_role_name(value: str) -> str:
    normalized = re.sub(r"[\s\u3000]+", " ", value).strip()
    return normalized

def _normalize_look_label(value: str) -> str:
    normalized = re.sub(r"[\s\u3000]+", "", value).strip()
    return normalized

def _split_colon(text: str) -> tuple[str, str]:
    if "：" in text:
        return text.split("：", 1)
    if ":" in text:
        return text.split(":", 1)
    return text, ""

def _has_colon(text: str) -> bool:
    return "：" in text or ":" in text

EXCLUDED_FIELDS = ["性格", "小传", "人物小传", "角色基础信息", "信息来源", "引用", "备注"]

def _extract_role_descriptions(body: str) -> dict[str, str]:
    roles: dict[str, str] = {}
    current_role: Optional[str] = None
    buffer: list[str] = []
    
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
            
        clean_line = line.lstrip("#").strip()
        
        # Detect start of other sections to close current role
        if clean_line.startswith("通用道具") or clean_line.startswith("场景"):
            if current_role:
                roles[current_role] = "；".join(buffer).strip("；")
            current_role = None
            buffer = []
            continue

        # Detect role definition
        if (clean_line.startswith("角色名") or clean_line.startswith("角色")) and _has_colon(clean_line):
            parts = _split_colon(clean_line)
            if len(parts) != 2:
                continue
                
            label, val = parts
            label = label.strip()
            val = val.strip()
            
            if label not in ["角色", "角色名"]:
                if label == "角色形象":
                    continue
                if current_role:
                    if label in EXCLUDED_FIELDS:
                        continue
                    if _has_colon(clean_line):
                        buffer.append(f"{label}：{val}")
                    else:
                        buffer.append(clean_line)
                continue
            
            if not val:
                continue
            
            if current_role:
                roles[current_role] = "；".join(buffer).strip("；")
            
            name = val.strip()
            normalized = _normalize_role_name(name)
            current_role = normalized if normalized else None
            buffer = []
            continue
            
        # Description lines
        if current_role:
            if clean_line.startswith("角色形象") or clean_line.startswith("-") or clean_line.startswith("•"):
                continue

            if _has_colon(line):
                label, value = _split_colon(line)
                label = label.strip()
                value = value.strip()
                if label in EXCLUDED_FIELDS:
                    continue
                if value:
                    buffer.append(f"{label}：{value}")
            else:
                buffer.append(line)
                
    if current_role:
        roles[current_role] = "；".join(buffer).strip("；")
    return roles

# Test case with bolding
test_content = """
### 角色列表

**角色名：张三**
角色基础信息：一个普通人
性别：男
年龄：25
长相（五官细节）：普通
四肢特征：普通
身材比例：普通
肤色：黄
皮肤状态：好
纹身：无
其他不可变识别点：无
性格：温和
小传：无
信息来源：剧本提及

**角色名：李四**
角色基础信息：另一个普通人
"""

print("Testing _extract_role_descriptions with bolding:")
result = _extract_role_descriptions(test_content)
print(result)

test_content_normal = """
### 角色列表

角色名：张三
角色基础信息：一个普通人
"""
print("\nTesting _extract_role_descriptions normal:")
result_normal = _extract_role_descriptions(test_content_normal)
print(result_normal)
