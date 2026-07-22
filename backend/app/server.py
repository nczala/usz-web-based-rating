from pathlib import Path
import base64
import hashlib
import hmac
import secrets
import re
import shutil
import numpy as np
import pandas as pd
import pydicom
from fastapi import FastAPI, HTTPException, Body, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from app.config import settings

MAX_PERCENTILE_SAMPLES_PER_SLICE = 50000
ADMIN_COOKIE_NAME = "admin_session"
ADMIN_SESSION_HEADER = "x-admin-session"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.frontend_origin,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def create_admin_cookie_value(session_token: str) -> str:
    payload = session_token.encode("utf-8")
    signature = hmac.new(
        settings.session_secret.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(payload + b"." + signature).decode("ascii")


def get_admin_session_token(cookie_value: str | None) -> str | None:
    if not cookie_value:
        return None

    try:
        decoded = base64.urlsafe_b64decode(cookie_value.encode("ascii"))
        payload, signature = decoded.split(b".", 1)
    except (ValueError, OSError):
        return None

    expected_signature = hmac.new(
        settings.session_secret.encode("utf-8"),
        payload,
        hashlib.sha256,
    ).digest()

    if not hmac.compare_digest(signature, expected_signature):
        return None

    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return None


def require_admin_session(request: Request):
    session_token = get_admin_session_token(request.cookies.get(ADMIN_COOKIE_NAME))
    session_header = request.headers.get(ADMIN_SESSION_HEADER)

    if not session_token or session_header != session_token:
        raise HTTPException(status_code=401, detail="Admin authentication required")


@app.get("/admin/session")
def get_admin_session(request: Request):
    session_token = get_admin_session_token(request.cookies.get(ADMIN_COOKIE_NAME))
    session_header = request.headers.get(ADMIN_SESSION_HEADER)
    is_authenticated = bool(session_token) and session_header == session_token
    return {"authenticated": is_authenticated}


@app.post("/admin/session")
def create_admin_session(response: Response, payload: dict = Body(...)):
    password = str(payload.get("password") or "")

    if password != settings.admin_password:
        raise HTTPException(status_code=401, detail="Incorrect password")

    session_token = secrets.token_urlsafe(32)
    response.set_cookie(
        key=ADMIN_COOKIE_NAME,
        value=create_admin_cookie_value(session_token),
        httponly=True,
        samesite="lax",
        secure=False,
    )
    return {"authenticated": True, "sessionToken": session_token}


@app.delete("/admin/session")
def delete_admin_session(response: Response):
    response.delete_cookie(
        key=ADMIN_COOKIE_NAME,
        httponly=True,
        samesite="lax",
        secure=False,
    )
    return {"authenticated": False}

def dicom_float_list(value):
    return [float(x) for x in value]


def get_scaled_pixels(ds):
    pixels = ds.pixel_array.astype(np.float32, copy=False)
    slope = float(getattr(ds, "RescaleSlope", 1) or 1)
    intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
    return pixels * slope + intercept


def sample_pixels_for_percentiles(pixels):
    values = pixels.reshape(-1)
    values = values[np.isfinite(values)]

    non_background = values[values != 0]
    if non_background.size > 0:
        values = non_background

    if values.size > MAX_PERCENTILE_SAMPLES_PER_SLICE:
        step = max(1, values.size // MAX_PERCENTILE_SAMPLES_PER_SLICE)
        values = values[::step]

    return values


def compute_series_display_range(samples):
    if not samples:
        return None

    all_values = np.concatenate(samples)
    if all_values.size == 0:
        return None

    lower = float(np.percentile(all_values, 1))
    upper = float(np.percentile(all_values, 99))

    if lower == upper:
        return None

    return {
        "lower": lower,
        "upper": upper,
    }


def read_series(folder: Path, prefix: str):
    if not folder.exists():
        raise HTTPException(status_code=500, detail=f"Invalid folder: {folder}")

    items = []
    percentile_samples = []

    for file in folder.rglob("*"):
        if not file.is_file() or file.name.startswith("."):
            continue

        try:
            ds = pydicom.dcmread(str(file), force=True)

            rel = file.relative_to(folder).as_posix()

            item = {
                "url": f"{prefix}/{rel}",
                "instanceNumber": int(getattr(ds, "InstanceNumber", 0)),
                "seriesNumber": int(getattr(ds, "SeriesNumber", 0)),
                "seriesDescription": str(getattr(ds, "SeriesDescription", "")),
                "frameOfReferenceUID": str(getattr(ds, "FrameOfReferenceUID", "")),
                "imagePositionPatient": dicom_float_list(ds.ImagePositionPatient),
                "imageOrientationPatient": dicom_float_list(ds.ImageOrientationPatient),
                "pixelSpacing": dicom_float_list(ds.PixelSpacing),
                "rows": int(ds.Rows),
                "columns": int(ds.Columns),
                "windowCenter": float(ds.WindowCenter[0] if isinstance(ds.WindowCenter, pydicom.multival.MultiValue) else ds.WindowCenter),
                "windowWidth": float(ds.WindowWidth[0] if isinstance(ds.WindowWidth, pydicom.multival.MultiValue) else ds.WindowWidth),
            }

            percentile_samples.append(sample_pixels_for_percentiles(get_scaled_pixels(ds)))
            items.append(item)

        except Exception as e:
            print(f"Skipping {file}: {e}")

    if not items:
        raise HTTPException(status_code=404, detail="No DICOM files found")

    items.sort(key=lambda x: x["instanceNumber"])

    display_range = compute_series_display_range(percentile_samples)
    if display_range is not None:
        for item in items:
            item["displayRangeLower"] = display_range["lower"]
            item["displayRangeUpper"] = display_range["upper"]

    return items

def load_case_from_id(case_id):
    df = pd.read_excel(settings.cases_excel_path, sheet_name=0)

    if "case_id" not in df.columns:
        raise HTTPException(status_code=500, detail="case.xlsx is missing the 'case_id' column")

    normalized_case_id = str(case_id).strip()
    normalized_ids = df["case_id"].astype(str).str.strip()
    case = df.loc[normalized_ids == normalized_case_id]

    if case.empty:
        raise HTTPException(status_code=404, detail=f"Case {case_id} not found")

    return case.iloc[0].to_dict()


def get_case_series_folder(case_id, series_name: str) -> Path:
    series_dir_map = {
        "axial": "tra_cropped",
        "sagittal": "sag",
    }

    if series_name not in series_dir_map:
        raise HTTPException(status_code=404, detail=f"Unknown series: {series_name}")

    normalized_case_id = str(case_id).strip()
    series_dir = series_dir_map[series_name]
    candidate_roots = [
        settings.cases_root / f"case_{normalized_case_id}",
        settings.cases_root / normalized_case_id,
        settings.dicom_web_viewer_root / f"case_{normalized_case_id}",
        settings.dicom_web_viewer_root / normalized_case_id,
    ]

    folder = None
    for root in candidate_roots:
        candidate = (root / series_dir).resolve()
        if candidate.exists():
            folder = candidate
            break

    if folder is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Series folder not found for case {case_id}. "
                f"Checked case-based folders for '{series_dir}'."
            ),
        )

    return folder


def resolve_case_dicom_path(case_id, series_name: str, dicom_path: str) -> Path:
    base_folder = get_case_series_folder(case_id, series_name)
    file_path = (base_folder / dicom_path).resolve()

    if base_folder not in file_path.parents and file_path != base_folder:
        raise HTTPException(status_code=400, detail="Invalid DICOM path")

    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="DICOM file not found")

    return file_path

@app.get("/dicom-series/case/{case_id}/axial")
def axial_series_by_case(case_id):
    folder = get_case_series_folder(case_id, "axial")
    return read_series(folder, f"/dicom/case/{case_id}/axial")

@app.get("/dicom-series/case/{case_id}/sagittal")
def sagittal_series_by_case(case_id):
    folder = get_case_series_folder(case_id, "sagittal")
    return read_series(folder, f"/dicom/case/{case_id}/sagittal")


@app.get("/dicom/case/{case_id}/axial/{dicom_path:path}")
def get_axial_dicom_by_case(case_id, dicom_path: str):
    file_path = resolve_case_dicom_path(case_id, "axial", dicom_path)
    return FileResponse(file_path, media_type="application/dicom")


@app.get("/dicom/case/{case_id}/sagittal/{dicom_path:path}")
def get_sagittal_dicom_by_case(case_id, dicom_path: str):
    file_path = resolve_case_dicom_path(case_id, "sagittal", dicom_path)
    return FileResponse(file_path, media_type="application/dicom")


def load_user_info(user_id):
    df = pd.read_excel(settings.users_excel_path, sheet_name=0)

    if "user_id" not in df.columns:
        raise HTTPException(status_code=500, detail="users.xlsx is missing the 'user_id' column")

    normalized_user_id = str(user_id).strip()
    normalized_ids = df["user_id"].astype(str).str.strip()
    user = df.loc[normalized_ids == normalized_user_id]

    if user.empty:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")

    return user.iloc[0].to_dict()


def normalize_user_name(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def build_user_slug(name: str, user_id: str, duplicate_count: int) -> str:
    normalized_name = normalize_user_name(name).lower()
    base_slug = re.sub(r"[^a-z0-9]+", "-", normalized_name).strip("-")

    if not base_slug:
        base_slug = f"user-{user_id}"

    if duplicate_count > 1:
        return f"{base_slug}-{user_id}"

    return base_slug


def load_users_dataframe():
    df = pd.read_excel(settings.users_excel_path, sheet_name=0)

    if "user_id" not in df.columns:
        raise HTTPException(status_code=500, detail="users.xlsx is missing the 'user_id' column")

    if "name" not in df.columns:
        raise HTTPException(status_code=500, detail="users.xlsx is missing the 'name' column")

    df = df.dropna(subset=["user_id", "name"]).copy()
    df["user_id"] = df["user_id"].astype(str).str.strip()
    df["name"] = df["name"].map(normalize_user_name)

    return df.loc[(df["user_id"] != "") & (df["name"] != "")]


def serialize_users(df: pd.DataFrame):
    normalized_names = df["name"].fillna("").map(normalize_user_name)
    name_counts = normalized_names.value_counts().to_dict()

    users = []
    for _, row in df.iterrows():
        user_id = str(row["user_id"]).strip()
        name = normalize_user_name(row.get("name"))
        group = str(row.get("group", "")).strip()
        slug = build_user_slug(name, user_id, name_counts.get(name, 0))
        solved_cases, total_cases = get_user_progress(user_id, group)

        users.append(
            {
                "user_id": user_id,
                "name": name,
                "group": group,
                "slug": slug,
                "solved_cases": solved_cases,
                "total_cases": total_cases,
            }
        )

    return users


def serialize_user_row(row: pd.Series, duplicate_count: int):
    user_id = str(row["user_id"]).strip()
    name = normalize_user_name(row.get("name"))
    group = str(row.get("group", "")).strip()
    slug = build_user_slug(name, user_id, duplicate_count)

    return {
        "user_id": user_id,
        "name": name,
        "group": group,
        "slug": slug,
    }


def get_next_user_id(df: pd.DataFrame) -> str:
    numeric_ids = pd.to_numeric(df["user_id"], errors="coerce").dropna()

    if numeric_ids.empty:
        return "1"

    return str(int(numeric_ids.max()) + 1)


def load_all_case_ids() -> list[int]:
    df = pd.read_excel(settings.cases_excel_path, sheet_name=0)

    if "case_id" not in df.columns:
        raise HTTPException(
            status_code=500,
            detail="all_cases.xlsx is missing the 'case_id' column",
        )

    case_ids = pd.to_numeric(df["case_id"], errors="coerce").dropna().astype(int).tolist()

    if not case_ids:
        raise HTTPException(status_code=500, detail="No cases found in all_cases.xlsx")

    return case_ids


def load_question_groups() -> list[str]:
    df = pd.read_excel(settings.questions_excel_path, sheet_name=0)

    if "group" not in df.columns:
        raise HTTPException(
            status_code=500,
            detail="questions.xlsx is missing the 'group' column",
        )

    groups = (
        df["group"]
        .dropna()
        .astype(str)
        .str.strip()
    )
    groups = sorted({group for group in groups.tolist() if group})

    if not groups:
        raise HTTPException(status_code=500, detail="No groups found in questions.xlsx")

    return groups


def create_randomized_order_file(path: Path):
    case_ids = load_all_case_ids()
    shuffled_case_ids = np.random.default_rng().permutation(case_ids).tolist()
    order_df = pd.DataFrame(
        {
            "order": range(1, len(shuffled_case_ids) + 1),
            "case_id": shuffled_case_ids,
        }
    )
    order_df.to_excel(path, index=False)


def create_empty_rating_file(path: Path):
    pd.DataFrame(columns=["order_id", "case_id"]).to_excel(path, index=False)


def create_user_record(name: str, group: str):
    normalized_name = normalize_user_name(name)
    normalized_group = str(group or "").strip()

    if not normalized_name:
        raise HTTPException(status_code=400, detail="User name is required")

    if not normalized_group:
        raise HTTPException(status_code=400, detail="User group is required")

    if normalized_group not in load_question_groups():
        raise HTTPException(
            status_code=400,
            detail=f"Unknown group '{normalized_group}'",
        )

    users_df = pd.read_excel(settings.users_excel_path, sheet_name=0)

    for required_column in ("user_id", "group", "name"):
        if required_column not in users_df.columns:
            raise HTTPException(
                status_code=500,
                detail=f"users.xlsx is missing the '{required_column}' column",
            )

    normalized_ids_df = users_df.dropna(subset=["user_id"]).copy()
    normalized_ids_df["user_id"] = normalized_ids_df["user_id"].astype(str).str.strip()
    user_id = get_next_user_id(normalized_ids_df)

    user_dir = settings.user_dir(normalized_group, user_id)
    order_path = settings.user_order_path(normalized_group, user_id)
    rating_path = settings.user_rating_path(normalized_group, user_id)

    if user_dir.exists():
        raise HTTPException(
            status_code=409,
            detail=f"User directory already exists for user {user_id}",
        )

    user_dir.mkdir(parents=True, exist_ok=False)

    try:
        create_randomized_order_file(order_path)
        create_empty_rating_file(rating_path)

        new_row = {column: None for column in users_df.columns}
        new_row["user_id"] = user_id
        new_row["group"] = normalized_group
        new_row["name"] = normalized_name

        users_df = pd.concat([users_df, pd.DataFrame([new_row])], ignore_index=True)
        users_df.to_excel(settings.users_excel_path, index=False)
    except Exception:
        shutil.rmtree(user_dir, ignore_errors=True)
        raise

    duplicate_count = (
        users_df["name"]
        .fillna("")
        .map(normalize_user_name)
        .value_counts()
        .get(normalized_name, 1)
    )

    return serialize_user_row(users_df.iloc[-1], duplicate_count)


def delete_user_record(user_id: str):
    user_info = load_user_info(user_id)
    user_group = str(user_info["group"]).strip()
    user_dir = settings.user_dir(user_group, str(user_id).strip())

    users_df = pd.read_excel(settings.users_excel_path, sheet_name=0)

    if "user_id" not in users_df.columns:
        raise HTTPException(
            status_code=500,
            detail="users.xlsx is missing the 'user_id' column",
        )

    normalized_user_id = str(user_id).strip()
    normalized_ids = users_df["user_id"].astype(str).str.strip()
    remaining_users_df = users_df.loc[normalized_ids != normalized_user_id].copy()

    if len(remaining_users_df.index) == len(users_df.index):
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")

    users_df_backup = users_df.copy()

    try:
        remaining_users_df.to_excel(settings.users_excel_path, index=False)

        if user_dir.exists():
            shutil.rmtree(user_dir)
    except Exception:
        users_df_backup.to_excel(settings.users_excel_path, index=False)
        raise


def resolve_user_by_slug_or_name(username: str):
    requested = normalize_user_name(username)
    requested_lower = requested.lower()
    users = serialize_users(load_users_dataframe())

    for user in users:
        if user["slug"].lower() == requested_lower:
            return user

    exact_name_matches = [
        user for user in users if normalize_user_name(user["name"]).lower() == requested_lower
    ]

    if len(exact_name_matches) == 1:
        return exact_name_matches[0]

    if len(exact_name_matches) > 1:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Username '{username}' is ambiguous. "
                "Use the slug returned by /users instead."
            ),
        )

    raise HTTPException(status_code=404, detail=f"Username '{username}' not found")


def load_user_order(user_id, user_group):
    df = pd.read_excel(settings.user_order_path(user_group, user_id), sheet_name=0)

    return df


def get_user_progress(user_id: str, user_group: str) -> tuple[int, int]:
    try:
        user_order = load_user_order(user_id, user_group)
        total_cases = len(user_order.index)
    except Exception:
        return 0, 0

    try:
        user_ratings = pd.read_excel(
            settings.user_rating_path(user_group, user_id),
            sheet_name=0,
        )
    except Exception:
        return 0, int(total_cases)

    if "order_id" not in user_ratings.columns or user_ratings.empty:
        return 0, int(total_cases)

    solved_cases = int(user_ratings["order_id"].dropna().astype(str).str.strip().ne("").sum())
    return solved_cases, int(total_cases)


def load_highest_rated_order_id(user_id, user_group):
    df = pd.read_excel(settings.user_rating_path(user_group, user_id), sheet_name=0)

    if "order_id" not in df.columns or df.empty:
        return 0

    highest_order_id = df["order_id"].dropna().max()

    if pd.isna(highest_order_id) or not highest_order_id:
        return 0

    return highest_order_id


@app.get("/users/{user_id}")
def get_user_state(user_id: str):

    # Load user information (users.xlsx) -> group / name
    user_info = load_user_info(user_id)
    user_group = user_info["group"]

    # Load user order (users/{group}/user_{id}/order_user_{id}.xlsx)
    user_order = load_user_order(user_id, user_group)
    number_of_cases = len(user_order.index)

    # Load user rating -> handle if no rating exists yet
    last_user_rating_order_id = load_highest_rated_order_id(user_id, user_group)

    if last_user_rating_order_id:
        matching_case_rows = user_order.loc[
            user_order["order"] == last_user_rating_order_id, "case_id"
        ]
        if matching_case_rows.empty:
            raise HTTPException(
                status_code=500,
                detail=f"Order {last_user_rating_order_id} is missing for user {user_id}",
            )
        last_user_rating_case_id = matching_case_rows.iloc[0]
    else:
        last_user_rating_order_id = int(user_order["order"].iloc[0])
        last_user_rating_case_id = user_order["case_id"].iloc[0]

    # return order_id, case_id, group -> load DICOM of case_id in frontend, visualize case (order_id) top right

    # Load question set with group ->

    return {
        "user_id": user_id,
        "user_group": user_group,
        "last_order_id": int(last_user_rating_order_id),
        "last_case_id": int(last_user_rating_case_id),
        "number_of_cases": int(number_of_cases),
        "user_order": (
            user_order[["order", "case_id"]]
            .replace({np.nan: None})
            .to_dict(orient="records")
        ),
    }


@app.get("/users")
def list_users(request: Request):
    require_admin_session(request)
    users = serialize_users(load_users_dataframe())
    return users


@app.get("/user-groups")
def list_user_groups(request: Request):
    require_admin_session(request)
    return load_question_groups()


@app.post("/users")
def create_user(request: Request, payload: dict = Body(...)):
    require_admin_session(request)
    return create_user_record(
        name=payload.get("name"),
        group=payload.get("group"),
    )


@app.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request):
    require_admin_session(request)
    delete_user_record(user_id)
    return {"deleted": True, "user_id": str(user_id).strip()}


@app.get("/users/by-name/{username}")
def get_user_by_name(username: str):
    return resolve_user_by_slug_or_name(username)

def load_questions_by_group(group: str):
    df = pd.read_excel(settings.questions_excel_path, sheet_name=0)
    df = df.replace({np.nan: None})

    questions = df.loc[df["group"] == group].to_dict(orient="records")
    return questions


@app.get("/users/{user_id}/questions")
def get_questions(user_id: str):

    # Load user information (users.xlsx) -> group / name
    user_info = load_user_info(user_id)
    user_group = user_info["group"]

    questions = load_questions_by_group(user_group)
    return questions


@app.get("/ratings/{user_id}/{order_id}")
def get_rating(user_id: str, order_id: str):
    user_ratings = load_user_ratings(user_id)
    user_group = load_user_info(user_id)["group"]
    user_order = load_user_order(user_id, user_group)

    if "order_id" in user_ratings.columns:
        user_ratings["order_id"] = user_ratings["order_id"].astype(str)

    if "order" in user_order.columns:
        user_order["order"] = user_order["order"].astype(str)

    mask = user_ratings["order_id"] == str(order_id)

    if not mask.any():
        order_match = user_order.loc[user_order["order"] == str(order_id), "case_id"]

        if order_match.empty:
            raise HTTPException(
                status_code=404,
                detail=f"Order {order_id} is missing for user {user_id}",
            )

        return {
            "order_id": order_id,
            "case_id": int(order_match.iloc[0]),
            "answers": {},
        }

    row = user_ratings.loc[mask].iloc[0].replace({np.nan: None}).to_dict()

    return {
        "order_id": row.get("order_id"),
        "case_id": row.get("case_id"),
        "answers": {
            key: value
            for key, value in row.items()
            if key not in {"order_id", "case_id"}
        },
    }


def load_user_ratings(user_id):
        user_group = load_user_info(user_id)["group"]
        df = pd.read_excel(settings.user_rating_path(user_group, user_id), sheet_name=0)
        return df

@app.post("/ratings/{user_id}/{order_id}")
def save_rating(user_id: str, order_id: str, payload: dict = Body(...)):

    # Prepare row
    new_record = {
        "order_id": str(order_id),
        "case_id": payload["caseId"],
    }

    for question in payload["answers"]:
        new_record[question] = payload["answers"][question]

    # Load current rating excel
    user_group = load_user_info(user_id)["group"]
    excel_file = settings.user_rating_path(user_group, user_id)

    df = pd.read_excel(excel_file)

    # Normalize id fields so updates don't fail on dtype mismatches.
    if "order_id" in df.columns:
        df["order_id"] = df["order_id"].astype(str)

    if "case_id" in df.columns:
        case_id_dtype = df["case_id"].dtype
        if pd.api.types.is_integer_dtype(case_id_dtype):
            new_record["case_id"] = int(new_record["case_id"])
        elif pd.api.types.is_float_dtype(case_id_dtype):
            new_record["case_id"] = float(new_record["case_id"])
        else:
            new_record["case_id"] = str(new_record["case_id"])

    # Check if case already processed -> add or update row
    mask = df["order_id"] == new_record["order_id"]

    if mask.any():
        df.loc[mask, new_record.keys()] = list(new_record.values())
        print("Updated existing rating!")
    else:
        df = pd.concat([df, pd.DataFrame([new_record])], ignore_index=True)
        print("Added new rating!")

    df.to_excel(excel_file, index=False)

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"

if frontend_dist.exists():

    @app.get("/")
    def serve_frontend():
        return FileResponse(frontend_dist / "index.html")

    app.mount(
        "/assets",
        StaticFiles(directory=frontend_dist / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}")
    def serve_frontend_path(full_path: str):
        requested_file = (frontend_dist / full_path).resolve()

        if requested_file.is_file() and frontend_dist in requested_file.parents:
            return FileResponse(requested_file)

        return FileResponse(frontend_dist / "index.html")
