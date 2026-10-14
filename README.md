# CivicVision AI — Community Civic Issue Reporting & Triage Platform

CivicVision AI is an intelligent civic engagement and issue remediation system. It features two independent frontends connected to a centralized, hardened Express and MongoDB backend.

---

## 1. System Architecture

```
                       +-----------------------------------+
                       |         MongoDB Atlas             |
                       | (Users, Admins, Issues, Votes)    |
                       +-----------------+-----------------+
                                         |
                                         | Mongoose
                                         v
                       +-----------------------------------+
                       |      CivicVision AI Backend       |
                       |           (backend1/)             |
                       |  - Port 5000 (Node.js / Express)  |
                       |  - Hardened Role Separation       |
                       |  - Private Admin CLI Provisioning |
                       +-----------------+-----------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
         REST API (Bearer Tokens)            REST API (Bearer Tokens)
         Role: "citizen"                     Role: "admin"
                       |                                   |
                       v                                   v
+-------------------------------+ +----------------------------------+
|    Citizen Frontend           | |     Admin Frontend               |
|      (frontend1/)             | |     (admin-frontend/)            |
| - Port 3000 (React)           | | - Port 3001 (React)              |
| - Issue reporting & voting    | | - Triage & remediation dashboard |
| - OpenStreetMap visualizer    | | - Department assignment          |
+-------------------------------+ +----------------------------------+
```

### Application Components
1. **`frontend1/` (Citizen Portal)**: Allows citizens to sign up, log in, browse community issues, vote on urgent community needs, and report new issues with location coordinates and photo evidence.
2. **`admin-frontend/` (Administrator Portal)**: Private console for municipal staff to triage, prioritize, update remediation status (`reported`, `in-progress`, `resolved`), assign municipal departments, and record confidential internal notes.
3. **`backend1/` (REST API & Services)**: Single central Express API with role-based JWT authentication, binary magic-byte image validation, Cloudinary storage, CORS allowlisting, and MongoDB persistence.

---

## 2. Quick Start: Local Development

### Prerequisites
- Node.js `v18+` (Tested on `v22.23.1`)
- npm `v10+`
- MongoDB Atlas connection string (or local MongoDB)
- Cloudinary credentials (for image uploads)

### Step 1: Backend Setup
```bash
cd backend1
npm install
cp .env.example .env
# Edit .env with your local or test credentials (MONGO_URI, JWT_SECRET, etc.)
npm start
```
*Backend runs on `http://localhost:5000`.*

### Step 2: Provision an Administrator Account
Admin accounts cannot be registered via the web interface. Provision an authorized account via the secure CLI:
```bash
cd backend1
npm run admin:create
```
Follow the interactive prompts (passwords are masked in the terminal).

### Step 3: Run Citizen Frontend
```bash
cd frontend1
npm install --legacy-peer-deps
cp .env.example .env
npm start
```
*Citizen portal runs on `http://localhost:3000`.*

### Step 4: Run Administrator Frontend
```bash
cd admin-frontend
npm install --legacy-peer-deps
cp .env.example .env
npm start
```
*Admin portal runs on `http://localhost:3001`.*

---

## 3. Environment Variables Reference

### `backend1/.env`
| Variable | Description | Example (Development) | Example (Production) |
|---|---|---|---|
| `PORT` | API server port | `5000` | `5000` |
| `NODE_ENV` | Runtime environment | `development` | `production` |
| `MONGO_URI` | MongoDB connection URI | `mongodb://localhost:27017/civicvision` | `mongodb+srv://<user>:<password>@cluster.mongodb.net/civicvision` |
| `JWT_SECRET` | Secret key for signing JWTs | `<random-32-character-secret>` | `<strong-production-secret>` |
| `CITIZEN_FRONTEND_ORIGIN` | Allowed citizen web origin | `http://localhost:3000` | `https://citizen.civicvision.gov` |
| `ADMIN_FRONTEND_ORIGIN` | Allowed admin web origin | `http://localhost:3001` | `https://admin.civicvision.gov` |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud account | `<cloud-name>` | `<cloud-name>` |
| `CLOUDINARY_API_KEY` | Cloudinary API key | `<api-key>` | `<api-key>` |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | `<api-secret>` | `<api-secret>` |

### `frontend1/.env`
| Variable | Description | Development | Production |
|---|---|---|---|
| `REACT_APP_API_URL` | Express API base URL | `http://localhost:5000` | `https://api.civicvision.gov` |

### `admin-frontend/.env`
| Variable | Description | Development | Production |
|---|---|---|---|
| `REACT_APP_API_URL` | Express API base URL | `http://localhost:5000` | `https://api.civicvision.gov` |
| `PORT` | Dev server port | `3001` | N/A |

---

## 4. Security & Authorization Matrix

| Endpoint | Method | Role Required | Citizen Access | Admin Access | Public Access |
|---|---|---|---|---|---|
| `/api/user/signup` | `POST` | None (Public) | Yes | Yes | Allowed |
| `/api/user/login` | `POST` | None (Public) | Yes | Yes | Allowed |
| `/api/user/profile` | `GET` | Citizen (`role: "citizen"`) | Allowed | **403 Forbidden** | **401 Unauthorized** |
| `/api/issues` | `POST` | Citizen (`role: "citizen"`) | Allowed | **403 Forbidden** | **401 Unauthorized** |
| `/api/issues/user` | `GET` | Citizen (`role: "citizen"`) | Allowed | **403 Forbidden** | **401 Unauthorized** |
| `/api/votes/:issueId` | `POST` | Citizen (`role: "citizen"`) | Allowed | **403 Forbidden** | **401 Unauthorized** |
| `/api/admin/signup` | `POST` | **Disabled** | **403 Forbidden** | **403 Forbidden** | **403 Forbidden** |
| `/api/admin/login` | `POST` | None (Public) | Yes | Yes | Allowed |
| `/api/admin/profile` | `GET` | Admin (`role: "admin"`) | **403 Forbidden** | Allowed | **401 Unauthorized** |
| `/api/admin-dashboard/issues` | `GET` | Admin (`role: "admin"`) | **403 Forbidden** | Allowed | **401 Unauthorized** |
| `/api/admin-dashboard/issues/:id` | `PATCH` | Admin (`role: "admin"`) | **403 Forbidden** | Allowed | **401 Unauthorized** |
| `/api/admin-dashboard/issues/:id` | `DELETE` | Admin (`role: "admin"`) | **403 Forbidden** | Allowed | **401 Unauthorized** |

---

## 5. Automated Verification Suite

Run all verification tests from their respective directories:

```bash
# 1. Backend Security & Role Isolation Suite (14 tests)
cd backend1 && npm test

# 2. HTTP Network & CORS Integration Suite (11 tests)
cd backend1 && node tests/http_integration.test.js

# 3. Private Admin CLI Provisioning Suite (7 tests)
cd backend1 && node tests/createAdmin.test.js

# 4. Citizen Frontend Suite (1 test)
cd frontend1 && npm test -- --watchAll=false

# 5. Admin Frontend Suite (7 tests)
cd admin-frontend && npm test -- --watchAll=false

# 6. Production Builds
cd frontend1 && npm run build
cd admin-frontend && npm run build
```

---

## 6. Separate Frontend Deployment Guide

Each frontend can be built and deployed independently without coupling:

### Citizen Frontend Deployment (`frontend1/`)
1. Set `REACT_APP_API_URL` to your production backend URL.
2. Build static artifacts:
   ```bash
   cd frontend1
   npm run build
   ```
3. Deploy the resulting `frontend1/build/` directory to static hosting (e.g. Vercel, Netlify, Cloudflare Pages, S3/CloudFront).

### Admin Frontend Deployment (`admin-frontend/`)
1. Set `REACT_APP_API_URL` to your production backend URL.
2. Build static artifacts:
   ```bash
   cd admin-frontend
   npm run build
   ```
3. Deploy the resulting `admin-frontend/build/` directory to your restricted internal hosting environment (e.g. behind VPN, corporate SSO, or password-protected subnet).
4. Update the backend environment variable `ADMIN_FRONTEND_ORIGIN` with the deployed admin frontend origin to authorize CORS communication.
