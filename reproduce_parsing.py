import asyncio
import httpx
import json

async def test_parsing():
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    endpoint = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    
    # Simulate a short script content
    file_text = """
    《 总 裁 夫 人 是 仙 界 大 佬 》
    第 一 集
    1-1、紫云殿 日 内/外
    人物：江柚、陆清寒、掌门、王师叔、杨珊、魔教杀手、弟子若干
    △ （特效）江柚、陆清寒与另外三名弟子御剑飞行，降至云雾缭绕的紫云殿。
    △ 五人步入正殿，前方掌门神情威严，居中位。刘、张二位师叔分坐两侧。
    五人（拱手，齐声）：参见掌门！
    陆清寒：禀告掌门，陆清寒已率紫云殿弟子荡平魔教余孽，安然凯旋！
    △ 掌门欣喜地点了点头。
    △ 众弟子欣喜的表情。
    △ 江柚站在陆清寒身旁，面露微笑，神情骄傲。
    掌门正色道：逆徒，还不跪下！
    """
    
    prompt = f"""
    请从以下剧本文件中提取信息，严格保持原文内容，不要进行任何改写、缩写、总结或润色。
    
    提取任务：
    1. 提取“主题”（theme）：提取剧本的主题或大纲，保持原文。
    2. 提取“角色列表”（characters）：提取所有角色的完整信息。不要提取角色的台词/对话，只提取“角色名”和“人物小传/描述”。
       - 如果原文中有该角色的人物小传/描述，请提取到 bio 字段。
       - 如果原文中没有人物小传，bio 字段请留空字符串。
       - 角色名必须是从原文中提取的真实姓名（如“李明”、“张三”），不要使用“角色1”、“男主”等代号，除非原文就是这么写的。
    3. 提取“分集列表”（episodes）：提取每一集的完整剧本内容。不要生成摘要，必须保留每一集的全部对话、动作和场景描写。

    请直接返回JSON格式的数据，不要包含Markdown代码块标记。
    JSON格式要求如下：
    {{
        "theme": "剧本主题（原文）",
        "characters": [
            {{"name": "角色名", "bio": "人物小传（原文，无则留空）"}},
            {{"name": "角色名", "bio": "人物小传（原文，无则留空）"}}
        ],
        "episodes": ["第一集完整内容（原文）", "第二集完整内容（原文）", ...]
    }}
    
    文件内容：
    {file_text} 
    """

    payload = {
        "model": "doubao-seed-2-0-pro-260215",
        "messages": [
            {"role": "system", "content": "你是一个严谨的剧本信息提取助手。请从用户提供的文本中按要求提取关键信息，禁止对原文进行任何修改、总结或润色。若文件过长，优先提取角色和分集内容。"},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.0,
        "max_tokens": 16000,
        "thinking": {"type": "disabled"}
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            print("Sending request to Volcengine...")
            resp = await client.post(endpoint, headers=headers, json=payload)
            print(f"Status: {resp.status_code}")
            if resp.status_code == 200:
                print("Response received:")
                print(resp.json()["choices"][0]["message"]["content"][:500])
            else:
                print(f"Error: {resp.text}")

    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    asyncio.run(test_parsing())
