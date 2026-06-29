from pathlib import Path
import numpy as np
import pandas as pd
import pydicom
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from app.config import settings

MAX_PERCENTILE_SAMPLES_PER_SLICE = 50000

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

    def parse_number(s):
        n = float(s)
        return int(n) if n.is_integer() else n

    case = load_case_from_id(case_id)

    patient_id = str(case["patient_id"]).strip()
    field_strength = parse_number(str(case["field_strength"]).strip())

    print(patient_id, field_strength)

    series_dir_map = {
        "axial": "tra",
        "sagittal": "sag",
    }

    if series_name not in series_dir_map:
        raise HTTPException(status_code=404, detail=f"Unknown series: {series_name}")

    folder = (
        settings.dicom_web_viewer_root
        / patient_id
        / f"{field_strength}T"
        / series_dir_map[series_name]
    ).resolve()

    if not folder.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Series folder not found for case {case_id}: {folder}",
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


def load_user_order(user_id, user_group):
    df = pd.read_excel(settings.user_order_path(user_group, user_id), sheet_name=0)

    return df


def load_highest_rated_order_id(user_id, user_group):
    df = pd.read_excel(settings.user_rating_path(user_group, user_id), sheet_name=0)

    highest_order_id = df['order_id'].max()

    if not highest_order_id:
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

    # Get case ID from order id
    last_user_rating_case_id = user_order.loc[user_order["order"] == last_user_rating_order_id, "case_id"].iloc[0]

    # return order_id, case_id, group -> load DICOM of case_id in frontend, visualize case (order_id) top right

    # Load question set with group ->

    return {
        "user_id": user_id,
        "user_group": user_group,
        "last_order_id": int(last_user_rating_order_id),
        "last_case_id": int(last_user_rating_case_id),
        "number_of_cases": int(number_of_cases)
    }

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

    if "order_id" in user_ratings.columns:
        user_ratings["order_id"] = user_ratings["order_id"].astype(str)

    mask = user_ratings["order_id"] == str(order_id)
    print(mask)

    if not mask.any():
        return {
            "order_id": order_id,
            "case_id": 2,
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
        df = pd.read_excel(settings.user_rating_path("radiology", user_id), sheet_name=0)
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
    excel_file = settings.user_rating_path("radiology", user_id)

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