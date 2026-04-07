# 项目开发规范 (RULES.md)

本文档是本项目的核心开发准则，适用于所有参与开发的工程师（包括 AI 辅助工具如 VibeCoding）。请严格遵守以下规定。

规则加载入口：
- Trae：`.trae/rules/project_rules.md`
- CodeBuddy（always）：`.codebuddy/rules/project_rules.md`

同步约定：`RULES.md`、`.trae/rules/project_rules.md`、`.codebuddy/rules/project_rules.md` 三处规则需保持语义一致，规则变更需同步更新。

补充说明：项目执行细则以 `.codebuddy/rules/project_rules.md` 为基准（含“自动执行脚本”与“云实例识别”规则），并同步到 `.trae/rules/project_rules.md`。

## 1. 核心原则 (Core Principles)

1.  **AI 友好 (AI-Friendly)**：
    -   代码必须包含明确的类型定义（Python Type Hints, TypeScript Interfaces）。
    -   函数和类必须包含 Docstring/JSDoc，说明输入输出与副作用。
    -   变量命名需具备自解释性，避免缩写（如使用 `user_id` 而非 `uid`）。
2.  **零污染 (No Pollution)**：
    -   严禁在项目根目录生成临时文件、临时 Markdown 文档、临时测试脚本。
    -   开发过程产生的临时 `.md`、`test_*.py`、`reproduce_*.py`、日志、导出包等，仅允许放在 `.vibecoding/` 或 `tmp/`。
    -   非业务必需的临时文档与脚本禁止进入版本库；提交前必须清理。
3.  **模块解耦 (Decoupling)**：
    -   前端（Frontend）与后端（Backend）必须保持独立部署能力。
    -   后端业务逻辑（Service Layer）与接口层（API Layer）分离。
    -   数据库模型（Models）与数据传输对象（Schemas/DTOs）分离。
    -   模块间通过稳定接口交互，禁止跨模块直接读取内部实现细节。
    -   新功能优先做最小侵入改造，避免耦合扩散，保证后续迭代可替换、可扩展。
4.  **验证优先 (Verification First)**：
    -   所有任务必须完成验证后才能交付（代码、配置、脚本、文档均适用）。
    -   任何代码变更必须经过验证（单元测试、集成测试或手动验证脚本）。
    -   严禁提交未经验证的代码。

## 2. 技术栈规范 (Tech Stack Standards)

### 2.1 后端 (Backend)
-   **语言**：Python 3.10+
-   **框架**：FastAPI (Async/Await)
-   **规范**：
    -   遵循 PEP 8 代码风格。
    -   使用 Pydantic V2 进行数据验证。
    -   使用 SQLAlchemy 2.0 (Async) 进行数据库操作。
    -   异常处理必须使用自定义 Exception 类，并通过 FastAPI 的 `HTTPException` 抛出。

### 2.2 前端 (Frontend)
-   **语言**：TypeScript 5.0+
-   **框架**：Next.js 14+ (App Router)
-   **规范**：
    -   使用 Functional Components + Hooks。
    -   严禁使用 `any` 类型，必须定义 Interface。
    -   组件必须保持“单一职责原则”。
    -   UI 库使用 Shadcn/UI + Tailwind CSS。

## 3. 文档与进度管理 (Documentation & Progress)

1.  **需求变更**：
    -   一旦用户需求发生变化，必须**同步更新** `PRD-短剧生成Web端应用-v1.0.md` 和 `TECH_DESIGN.md`。
    -   更新必须在代码修改之前完成。
2.  **进度追踪**：
    -   任何项目改动都必须记录在 `PROGRESS.md` 中，不限于主要变更。
    -   `PROGRESS.md` 只允许追加，不允许覆盖、删改历史记录。
    -   记录格式：`YYYY-MM-DD` - `类别` - `描述`。

## 4. AI 协作指南 (VibeCoding Guide)

-   **上下文引用**：在提问或生成代码时，明确引用相关文件路径。
-   **错误修正**：如果 AI 生成的代码有误，必须在修正后更新 `PROGRESS.md` 说明修复内容。
-   **语言**：所有回复、沟通与文档必须使用**中文 (简体)**。

## 5. 部署与环境 (Deployment)

-   **Docker**：所有服务必须提供 `Dockerfile`，且能通过 `docker-compose up` 一键启动。
