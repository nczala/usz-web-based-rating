# Web-based rating tool

## Run

Create a local `.env` file in `backend/` first. The backend now loads it automatically on startup.

Example:

```env
DATA_DIR=./data
DICOM_WEB_VIEWER_ROOT=C:\path\to\web-viewer
CASES_EXCEL_PATH=./data/all_cases.xlsx
USERS_EXCEL_PATH=./data/users/users.xlsx
QUESTIONS_EXCEL_PATH=./data/rating_questions/questions.xlsx
CASES_ROOT=./data/cases
ADMIN_PASSWORD=freeMax
SESSION_SECRET=replace-this-with-a-random-secret
FRONTEND_ORIGIN=http://localhost:5173
```

Make sure to have ```backend``` as working directory & then run in terminal:

```uvicorn app.main:app --reload```

For the full backend used by the frontend, run:

```uvicorn app.server:app --host 0.0.0.0 --port 8000```

Windows deployment needs these environment variables in `.env`:

```env
DATA_DIR=./data
DICOM_WEB_VIEWER_ROOT=C:\path\to\web-viewer
```

## Endpoints

Open localhost: ``http://127.0.0.1:8000/``

### Cases

Get case by id: ``http://127.0.0.1:8000/cases/{CASE_ID}``
