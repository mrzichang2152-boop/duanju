#!/bin/bash

# 部署脚本 - 火山云服务器

# 设置错误时退出
set -e

echo "🚀 开始部署..."

# 1. 拉取最新代码
echo "📥 拉取最新代码..."
git pull origin main

# 2. 部署后端
echo "🐍 部署后端..."
cd backend
if [ ! -d "venv" ]; then
    echo "创建 Python 虚拟环境..."
    python3 -m venv venv
fi

source venv/bin/activate
echo "安装后端依赖..."
pip install -r requirements.txt

# 如果有数据库迁移，可以在这里添加
# alembic upgrade head

cd ..

# 3. 部署前端
echo "⚛️ 部署前端..."
cd frontend
echo "安装前端依赖..."
npm install
echo "构建前端..."
npm run build
cd ..

# 4. 使用 PM2 重启服务
# 检查是否安装了 PM2
if ! command -v pm2 &> /dev/null; then
    echo "PM2 未安装，正在安装..."
    npm install -g pm2
fi

echo "🔄 重启服务..."

# 启动/重启后端 (Python)
# 注意：这里假设使用 uvicorn 启动，端口 8000
pm2 start "cd backend && source venv/bin/activate && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000" --name "video-gen-backend" --update-env || pm2 restart "video-gen-backend" --update-env

# 启动/重启前端 (Next.js)
# 注意：Next.js 默认端口 3000
pm2 start "cd frontend && npm start -- -p 3000" --name "video-gen-frontend" --update-env || pm2 restart "video-gen-frontend" --update-env

echo "✅ 部署完成！"
echo "后端运行在端口 8000"
echo "前端运行在端口 3000"
pm2 save
