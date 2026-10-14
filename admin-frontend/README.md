# CivicVision AI — Administrator Portal (`admin-frontend`)

## 1. Overview
The **CivicVision AI Administrator Portal** is a dedicated, secure single-page application built with React for authorized municipal authorities, public works staff, and city administrators. It operates independently from the citizen-facing application (`frontend1/`) and connects to the central CivicVision AI backend (`backend1/`).

### Key Capabilities
- **Strict Role-Gated Access**: Dedicated admin authentication using JWT bearer tokens with verified `role: "admin"`.
- **Zero Public Signup**: Public administrator registration and self-enrollment are completely disabled. Admin accounts are provisioned exclusively through the backend CLI.
- **Triage & Issue Lifecycle Management**: View, filter, and inspect community civic issues with full reporter attribution. Update status (`reported`, `in-progress`, `resolved`), assign municipal departments, and record confidential internal notes.
- **Clean Token Isolation**: Separate `adminToken` storage prevents session collisions with citizen accounts on the same machine.

---

## 2. Local Installation & Development

### Prerequisites
- Node.js `v18+` (tested with Node `v22.23.1`)
- npm `v10+`

### Installation
From the repository root:
```bash
cd admin-frontend
npm install --legacy-peer-deps
```

### Running Locally
To launch the development server on `http://localhost:3001`:
```bash
npm start
```
*(Port 3001 is pre-configured in `.env` to prevent port collisions with the citizen frontend running on 3000).*

---

## 3. Environment Configuration

Copy the provided placeholder template to create your local `.env`:
```bash
cp .env.example .env
```

### Environment Variables
| Variable | Description | Local Value (Example) | Production Value (Example) |
|---|---|---|---|
| `REACT_APP_API_URL` | Base URL of the CivicVision AI Express API | `http://localhost:5000` | `https://api.civicvision.gov` |
| `PORT` | Local React development server port | `3001` | N/A (Build static bundle) |

> **Security Note:** Never commit secrets, passwords, or production keys to this file. Only placeholder templates (`.env.example`) are tracked in source control.

---

## 4. Admin Account Provisioning

Administrator accounts cannot be registered from the web application. An authorized system administrator must provision accounts using the private CLI script in `backend1/`:

```bash
cd ../backend1
npm run admin:create
```

Follow the interactive prompts:
```
--- CivicVision AI: Provision Administrator Account ---
Full Name: Jane Doe
Email: jane.doe@civicvision.gov
Password: [hidden input]
```

---

## 5. Testing & Production Build

### Running Tests
Execute the isolated Jest & React Testing Library suite:
```bash
npm test -- --watchAll=false
```

### Production Build
Compile the optimized, minified production assets into the `build/` directory:
```bash
npm run build
```

---

## 6. Backend API Endpoints Utilized

The admin portal interacts exclusively with the authorized administrative endpoints:

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/admin/login` | Authenticate admin via email & password | None |
| `GET` | `/api/admin/profile` | Verify session validity & ensure `role: "admin"` | Admin Bearer Token |
| `GET` | `/api/admin-dashboard/issues` | Retrieve all community issues with populated reporter info | Admin Bearer Token |
| `GET` | `/api/admin-dashboard/issues/filter` | Query issues by status and category | Admin Bearer Token |
| `PATCH` | `/api/admin-dashboard/issues/:id` | Update remediation status, assigned department, internal notes | Admin Bearer Token |
| `DELETE` | `/api/admin-dashboard/issues/:id` | Permanently delete an issue record | Admin Bearer Token |
