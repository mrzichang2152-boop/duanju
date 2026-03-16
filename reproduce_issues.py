
import sys
import os

# Add the project root to the python path so we can import app modules
sys.path.append(os.path.join(os.getcwd(), "backend"))

from app.services.assets import _extract_role_descriptions, _extract_role_looks

sample_text = """
角色名：江柚 
角色基础信息：仙界紫云殿首徒，转世为霍炎川法定妻子，武力值满点，左眼尾下有颗淡红小泪痣 
性别：女 
年龄：外表22岁/修仙龄1200岁 
身高：168cm 
长相（五官细节）：丹凤眼眼尾上挑，高挺细鼻，M型薄唇，鹅蛋脸，左眼尾淡红泪痣，生气时眼尾会泛薄红 
四肢特征：纤细但爆发力极强，凝灵力时指尖会下意识微蜷，出拳速度快到留残影 
身材比例：7.5头身，腰细腿长，腿长占全身比例60% 
肤色：冷白 
皮肤状态：滑嫩无瑕疵 
纹身：无 
其他不可变识别点：左眼尾淡红泪痣，右耳垂有1个细耳洞，惯用右手，清冷御姐音，情绪波动时指尖会泛金色灵光 
性格：睚眦必报，对善意者温和柔软，行事杀伐果断，自带上位者气场 
小传：前世是紫云殿天赋最高的首徒，与魔尊陆清寒相恋，被信任的师门、师妹联手害死，魂穿到现代饱受排挤的霍家少夫人身上，绑定系统需杀死转世的陆清寒（霍炎川）即可重回仙界报仇 
信息来源：剧本提及+导演补全 
角色形象： 
- 紫云殿首徒造型：月白绣银线云纹广袖仙裙，云纹布靴，流云银簪束高马尾，淡粉仙娥妆，面料为流光云锦，清冷出尘，记忆点为发簪是陆清寒前世所赠 
- 泳池刚醒造型：湿透的淡蓝色莫代尔吊带睡裙，白色塑料凉拖，黑长直湿发贴脸，素颜唇色发白，狼狈但眼神冷冽 
- 霍家家居造型：黑色垂坠真丝睡袍，珍珠平底拖，半扎低马尾，伪素颜，舒适随性 
- 霍家宴造型：酒红色哑光深V丝绒长裙，10cm红底细跟鞋，碎钻水滴耳坠，大波浪卷发，浓艳御姐妆，记忆点为领口别一枚鸽血红碎钻胸针 
"""

print("--- Testing _extract_role_descriptions ---")
descriptions = _extract_role_descriptions(sample_text)
for role, desc in descriptions.items():
    print(f"Role: {role}")
    print(f"Description length: {len(desc)}")
    if "性格" in desc:
        print("FAIL: '性格' found in description.")
    else:
        print("SUCCESS: '性格' NOT found in description.")
    
    if "小传" in desc:
        print("FAIL: '小传' found in description.")
    else:
        print("SUCCESS: '小传' NOT found in description.")

print("\n--- Testing _extract_role_looks ---")
looks = _extract_role_looks(sample_text)
for role, role_looks in looks.items():
    print(f"Role: {role}")
    print(f"Number of looks: {len(role_looks)}")
    for look_name, look_desc in role_looks:
        print(f"  Look: {look_name}")
        print(f"  Desc preview: {look_desc[:50]}...")
