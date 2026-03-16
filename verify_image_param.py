
import asyncio
import base64
import httpx
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def verify_image_param():
    api_key = "6002c554-3d7f-4293-80e9-c217758ba983"
    endpoint = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    
    # Generate 100x100 white image
    from PIL import Image
    import io
    
    img = Image.new('RGB', (100, 100), color='white')
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG")
    b64_data = base64.b64encode(buffer.getvalue()).decode("utf-8")
    image_data = f"data:image/jpeg;base64,{b64_data}"
    
    logger.info(f"Using image parameter with 100x100 image")
    
    payload = {
        "model": "doubao-seedream-4-5-251128",
        "prompt": "Test prompt for image param",
        # New parameter: 'image' as a list of strings
        "image": [image_data],
        "return_url": True,
        "strength": 0.7
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    logger.info("Sending request...")
    
    async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
        try:
            response = await client.post(
                endpoint,
                headers=headers,
                json=payload
            )
            logger.info(f"Status: {response.status_code}")
            if response.status_code == 200:
                logger.info(f"Success: {response.json()}")
            else:
                logger.error(f"Error: {response.text}")
        except Exception as e:
            logger.error(f"Exception: {e}")

if __name__ == "__main__":
    asyncio.run(verify_image_param())
