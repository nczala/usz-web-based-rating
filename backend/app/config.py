import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    backend_root: Path
    data_dir: Path
    cases_excel_path: Path
    users_excel_path: Path
    questions_excel_path: Path
    cases_root: Path
    dicom_web_viewer_root: Path

    def user_dir(self, user_group: str, user_id: str) -> Path:
        return self.data_dir / "users" / user_group / f"user_{user_id}"

    def user_order_path(self, user_group: str, user_id: str) -> Path:
        return self.user_dir(user_group, user_id) / f"order_user_{user_id}.xlsx"

    def user_rating_path(self, user_group: str, user_id: str) -> Path:
        return self.user_dir(user_group, user_id) / f"rating_user_{user_id}.xlsx"


def _resolve_path(value: str | None, default: Path) -> Path:
    if not value:
        return default.resolve()

    return Path(value).expanduser().resolve()


BACKEND_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = BACKEND_ROOT / "data"

load_dotenv(BACKEND_ROOT / ".env")

settings = Settings(
    backend_root=BACKEND_ROOT,
    data_dir=_resolve_path(os.getenv("DATA_DIR"), DEFAULT_DATA_DIR),
    cases_excel_path=_resolve_path(
        os.getenv("CASES_EXCEL_PATH"), DEFAULT_DATA_DIR / "all_cases.xlsx"
    ),
    users_excel_path=_resolve_path(
        os.getenv("USERS_EXCEL_PATH"), DEFAULT_DATA_DIR / "users" / "users.xlsx"
    ),
    questions_excel_path=_resolve_path(
        os.getenv("QUESTIONS_EXCEL_PATH"),
        DEFAULT_DATA_DIR / "rating_questions" / "questions.xlsx",
    ),
    cases_root=_resolve_path(os.getenv("CASES_ROOT"), DEFAULT_DATA_DIR / "cases"),
    dicom_web_viewer_root=_resolve_path(
        os.getenv("DICOM_WEB_VIEWER_ROOT"),
        Path("/media/nico/Extreme SSD/USZ/data_freeMax/web-viewer"),
    ),
)
