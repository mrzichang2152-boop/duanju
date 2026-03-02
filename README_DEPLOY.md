# 部署指南 - 火山云服务器

本指南将帮助您将项目部署到火山云服务器（或其他 Linux 服务器）。

## 准备工作

1.  **购买/登录服务器**：
    *   确保您已购买火山云服务器（ECS）。
    *   操作系统建议：Ubuntu 20.04/22.04 LTS 或 CentOS 7/8。
    *   确保开放了必要的端口（默认脚本使用 **8000** 和 **3000**）。

2.  **连接服务器**：
    ```bash
    ssh root@your_server_ip
    ```

3.  **安装基础环境** (如果是 Ubuntu)：
    ```bash
    # 更新包列表
    sudo apt update

    # 安装 Git
    sudo apt install -y git

    # 安装 Python 3.8+ 和 pip
    sudo apt install -y python3 python3-pip python3-venv

    # 安装 Node.js 18+ (使用 nvm 或直接安装)
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
    ```

## 部署步骤 (使用 PM2 - 推荐)

我们提供了一个自动部署脚本 `deploy.sh`，使用 PM2 管理进程。

1.  **克隆代码**：
    ```bash
    git clone https://github.com/mrzichang2152-boop/duanju.git
    cd duanju
    ```

2.  **赋予脚本执行权限**：
    ```bash
    chmod +x deploy.sh
    ```

3.  **运行部署脚本**：
    ```bash
    ./deploy.sh
    ```
    脚本会自动：
    *   拉取最新代码
    *   创建/激活 Python 虚拟环境并安装依赖
    *   安装前端依赖并构建
    *   安装 PM2（如果没有）
    *   启动/重启后端服务 (端口 8000)
    *   启动/重启前端服务 (端口 3000)

4.  **访问应用**：
    *   前端：`http://your_server_ip:3000`
    *   后端 API：`http://your_server_ip:8000`

## 常见问题

1.  **端口被占用**：
    *   使用 `netstat -tulpn | grep 3000` 查看占用进程。
    *   在 `deploy.sh` 中修改端口号。

2.  **环境变量**：
    *   在 `backend` 目录下创建 `.env` 文件以配置数据库、API 密钥等。
    *   在 `frontend` 目录下创建 `.env.local` 以配置前端环境变量。

3.  **Nginx 反向代理 (可选)**：
    *   如果您想通过域名访问（如 `http://example.com`），建议配置 Nginx 反向代理到 3000 端口。
    *   参考项目根目录下的 `nginx.conf`（注意修改 `proxy_pass` 地址）。

## Docker 部署 (高级)

如果您熟悉 Docker，也可以使用 Docker Compose 部署：

1.  安装 Docker 和 Docker Compose。
2.  运行：
    ```bash
    docker-compose up -d --build
    ```
3.  访问端口：`8088` (Nginx), `3001` (Frontend), `8003` (Backend)
