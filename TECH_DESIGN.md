# Technical Design Document: Short Play Generation Web App (v1.0)

This document outlines the technical architecture, stack selection, and implementation guidelines for the Short Play Generation Web Application, based on the provided PRD. It is designed to be **AI-friendly** for development with VibeCoding tools, ensuring modularity, maintainability, and clear boundaries.

## 1. Project Overview & Architecture

### 1.1 Goal
Build a web application that allows users to generate short play videos from text/scripts using AI models (via LinkAPI). The process involves script formatting, asset generation (images), video segment generation, and final video merging.

### 1.2 High-Level Architecture
The system follows a modern client-server architecture, decoupled to allow independent scaling and maintenance.

*   **Frontend (SPA/SSR)**: Handles UI, user interaction, state management, and real-time updates.
*   **Backend (API Server)**: Handles business logic, database operations, LinkAPI integration, and long-running tasks (video merging).
*   **Database**: Stores user data, project metadata, scripts, and asset references.
*   **Object Storage (OSS)**: Stores generated images, video segments, and final video files.
*   **Task Queue**: Handles asynchronous operations like video generation polling and video merging (FFmpeg).

```mermaid
graph TD
    Client[Web Browser (Frontend)] <-->|REST API / WebSocket| API[Backend API Server]
    API <-->|SQL| DB[(PostgreSQL)]
    API <-->|Redis| Queue[Task Queue (Celery/Bull)]
    API <-->|HTTP| LinkAPI[LinkAPI Gateway]
    Queue -->|FFmpeg| Worker[Worker Process]
    Worker <-->|Read/Write| OSS[Alibaba Cloud OSS]
    Worker --> LinkAPI
```

## 2. Tech Stack Selection

Selected for robustness, developer experience, and AI-coding friendliness (strong typing, clear patterns).

### 2.1 Frontend
*   **Framework**: **Next.js 14+ (App Router)** - React framework for production. Offers excellent typing and structure.
*   **Language**: **TypeScript** - Mandatory for AI reliability and code safety.
*   **UI Library**: **Tailwind CSS** + **Shadcn/UI** - Rapid development, accessible, easy for AI to generate consistent UI.
*   **State Management**: **Zustand** or **React Query** (TanStack Query) - For server state synchronization.
*   **Video Player**: **Remotion** (Optional, for preview) or standard HTML5 Video with custom controls.

### 2.2 Backend
*   **Framework**: **FastAPI** (Python 3.10+) - High performance, easy to read, native async support, excellent for AI/Data workflows.
*   **Database ORM**: **SQLAlchemy (Async)** or **Prisma** - Type-safe database access.
*   **Task Queue**: **Celery** (with Redis) - Robust standard for Python background tasks.
*   **Video Processing**: **FFmpeg** (wrapper: `ffmpeg-python`) - Industry standard for video manipulation.

### 2.3 Infrastructure (Alibaba Cloud)
*   **Compute**: ECS (Elastic Compute Service) - Running Docker containers (Frontend, Backend, Worker).
*   **Database**: RDS for PostgreSQL - Managed database service.
*   **Storage**: OSS (Object Storage Service) - Scalable storage for media assets.
*   **Cache/Queue**: Redis (on ECS or managed ApsaraDB for Redis).

## 3. Modular Design & Project Structure

To support VibeCoding and prevent pollution, we strictly separate source code from generated artifacts.

### 3.1 Directory Structure
```
short-play-app/
├── .vibecoding/           # VibeCoding scratchpad & logs (GitIgnored)
├── docs/                  # Project documentation (PRD, Tech Design)
├── deploy/                # Docker & Deployment configs
├── frontend/              # Next.js Application
│   ├── src/
│   │   ├── app/           # App Router pages
│   │   ├── components/    # Reusable UI components
│   │   ├── lib/           # Utilities (API client, helpers)
│   │   ├── types/         # TypeScript interfaces (Shared with Backend via generation or manual sync)
│   │   └── hooks/         # Custom React hooks
│   ├── public/
│   └── next.config.mjs
├── backend/               # FastAPI Application
│   ├── app/
│   │   ├── api/           # Route handlers (Endpoints)
│   │   ├── core/          # Config, Security, Database connection
│   │   ├── models/        # SQLAlchemy Database Models
│   │   ├── schemas/       # Pydantic Models (Request/Response)
│   │   ├── services/      # Business Logic (LinkAPI, FFmpeg, Asset Mgmt)
│   │   └── worker/        # Celery tasks
│   ├── tests/
│   └── requirements.txt
├── scripts/               # Utility scripts (setup, migration)
├── docker-compose.yml     # Local development orchestration
├── .gitignore
└── README.md
```

### 3.2 VibeCoding Best Practices (Rules)
1.  **Isolation**: All AI-generated temporary files, logs, or "thinking" documents must go into `.vibecoding/` or `tmp/`, which are `.gitignore`d.
2.  **Explicit Context**: When asking AI to edit code, reference the specific file path.
3.  **Type Hints**: All Python code MUST use Type Hints. All JS code MUST be TypeScript. This helps the AI understand data structures.
4.  **Env Variables**: Never hardcode secrets. Use `.env` files (added to `.gitignore`).

## 4. Database Schema (PostgreSQL)

Based on the PRD Data Model.

### 4.1 Tables
*   **users**: `id`, `email`, `password_hash`, `created_at`
*   **projects**: `id`, `user_id`, `name`, `status` (SCRIPT/ASSETS/VIDEO/FINAL), `linkapi_key_ref`, `created_at`
*   **scripts**: `id`, `project_id`, `content` (JSONB), `version`, `is_active`
*   **assets**: `id`, `project_id`, `type` (CHARACTER/PROP/SCENE), `name`, `description`
*   **asset_versions**: `id`, `asset_id`, `image_url`, `is_selected`, `created_at`
*   **video_segments**: `id`, `project_id`, `script_scene_id`, `text_content`, `order_index`
*   **segment_versions**: `id`, `segment_id`, `video_url`, `status` (PENDING/COMPLETED/FAILED), `is_selected`
*   **final_videos**: `id`, `project_id`, `video_url`, `status`, `created_at`

## 5. API Design (RESTful)

### 5.1 Auth
*   `POST /auth/register`
*   `POST /auth/login` (Returns JWT)

### 5.2 Projects
*   `GET /projects`
*   `POST /projects`
*   `GET /projects/{id}`
*   `DELETE /projects/{id}`

### 5.3 Step 1: Script
*   `POST /projects/{id}/script/generate` (Calls LinkAPI to generate/format script)
*   `POST /projects/{id}/script/validate` (Runs validation rules)
*   `GET /projects/{id}/script`

### 5.4 Step 2: Assets
*   `POST /projects/{id}/assets/extract` (Extracts entities from script)
*   `POST /projects/{id}/assets/{asset_id}/generate` (Generates image via LinkAPI)
*   `PUT /projects/{id}/assets/{asset_id}/select` (Selects preferred version)

### 5.5 Step 3: Video Segments
*   `POST /projects/{id}/segments/generate` (Generates video for a segment)
*   `GET /projects/{id}/segments`

### 5.6 Step 4: Finalize
*   `POST /projects/{id}/merge` (Triggers async merge task)
*   `GET /projects/{id}/final`

## 6. LinkAPI & AI Integration Strategy

### 6.1 Configuration
*   Base URL: `https://docs.linkapi.ai/` (as per user input, though standard might be `api.linkapi.ai`, we will make this configurable).
*   Authentication: Bearer Token (User provided or System provided).
*   **Model Selection**: The frontend will allow users to select models. These selections are passed in the API request body to the backend.

### 6.2 Implementation
*   **Service Layer**: Create a `LinkAPIService` in the backend.
*   **Proxying**: The backend acts as a secure proxy. It injects the API Key (decrypted from DB) and forwards the request to LinkAPI.
*   **Streaming**: For text generation (Step 1), use Server-Sent Events (SSE) or WebSocket to stream the response to the frontend for a better UX.
*   **Polling**: For video/image generation (which might be async on LinkAPI side), the backend should handle polling or webhook reception (if available), then update the DB status.

## 7. Video Processing (FFmpeg)

### 7.1 Merging Logic
1.  **Download**: Worker downloads all selected `segment_versions` (MP4) from OSS to a local temporary directory.
2.  **Normalization**: Ensure all segments have the same resolution, frame rate, and codec. Use FFmpeg to transcode if necessary.
3.  **Concat**: Create a `concat.txt` file listing all segments.
4.  **Merge**: Run `ffmpeg -f concat -i concat.txt -c copy output.mp4` (if formats match) or re-encode.
5.  **Upload**: Upload `output.mp4` to OSS.
6.  **Cleanup**: Delete local temp files.

## 8. Deployment Strategy (Alibaba Cloud)

### 8.1 Dockerization
*   `Dockerfile.frontend`: Multi-stage build (Node build -> Nginx or Next.js server).
*   `Dockerfile.backend`: Python base, install requirements, run Uvicorn.
*   `Dockerfile.worker`: Python base, run Celery worker.

### 8.2 Environment Variables
*   `DATABASE_URL`: Connection string for RDS.
*   `REDIS_URL`: Connection string for Redis.
*   `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`: For OSS access.
*   `LINKAPI_BASE_URL`: API endpoint.
*   `SECRET_KEY`: For JWT encryption.

### 8.3 CI/CD (Future)
*   GitHub Actions / GitLab CI to build images and push to ACR (Alibaba Cloud Container Registry).

## 9. Next Steps for Development

1.  **Initialize Repo**: Set up the folder structure.
2.  **Backend Setup**: Initialize FastAPI, SQLAlchemy, and basic Auth.
3.  **Frontend Setup**: Initialize Next.js with Tailwind.
4.  **LinkAPI Connector**: Implement the basic wrapper for LinkAPI.
5.  **Iterative Implementation**:
    *   Iteration 1: Project Mgmt + Script Editor (Step 1).
    *   Iteration 2: Asset Generation (Step 2).
    *   Iteration 3: Video Generation (Step 3).
    *   Iteration 4: Merging & Final Polish (Step 4).
