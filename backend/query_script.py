import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select
from app.models.script import Script

DATABASE_URL = "sqlite+aiosqlite:///./test.db"  # Assuming sqlite, let's check
engine = create_async_engine(DATABASE_URL)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def main():
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Script).order_by(Script.created_at.desc()).limit(1))
        script = result.scalar_one_or_none()
        if script:
            print(f"Content: {script.content[:500]}")
            print("...")
            # print table cells containing AssetID
            for line in script.content.split('\n'):
                if 'AssetID' in line:
                    print(line)
        else:
            print("No script found")

asyncio.run(main())
