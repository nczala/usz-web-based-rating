from fastapi import APIRouter, Depends, HTTPException
from app.services.case_service import CaseService
from app.config import settings
from fastapi.responses import FileResponse
from pathlib import Path
router = APIRouter(prefix="/cases", tags=["cases"])


def get_case_service() -> CaseService:
    return CaseService()

# CASE INFO

@router.get("/")
def list_cases():
    return [{"id": 1, "name": "Nico"}]

@router.get("/{case_id}")
def get_case(case_id: int, service: CaseService = Depends(get_case_service)):
    return service.get_case(case_id)

CASE_ROOT = settings.cases_root

# DICOMs

@router.get("/{case_id}/dicoms")
def list_dicoms(case_id: str):
    folder = CASE_ROOT / f"case_{case_id}"

    if not folder.is_dir():
        raise HTTPException(status_code=404, detail="Case DICOM folder not found")

    files = sorted([
        p.name for p in folder.iterdir()
        if p.is_file() and not p.name.startswith(".")
    ])

    return [f"/api/cases/{case_id}/dicoms/{name}" for name in files]

@router.get("/{case_id}/dicoms/{filename}")
def get_dicom(case_id: str, filename: str):
    path = CASE_ROOT / f"case_{case_id}" / filename

    if not path.is_file():
        raise HTTPException(status_code=404, detail="DICOM file not found")

    return FileResponse(path, media_type="application/dicom")
