#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

import numpy as np
import pydicom
from pydicom.uid import generate_uid

# Configure these values before running the script.
patient = "Pat020"
field_strength = "0.55"

SOURCE_DIR = Path(f"/media/nico/Extreme SSD/USZ/data_freeMax/web-viewer/{patient}/{field_strength}T/tra")
OUTPUT_DIR = Path(f"/media/nico/Extreme SSD/USZ/data_freeMax/web-viewer/{patient}/{field_strength}T/tra_cropped")
X_START = 135
X_END = 325

SERIES_DESCRIPTION_SUFFIX = " [cropped]"
DRY_RUN = False


def validate_crop(x_start: int, x_end: int) -> None:
    if x_start < 0:
        raise ValueError("X_START must be >= 0.")
    if x_end <= 0:
        raise ValueError("X_END must be > 0.")
    if x_start >= x_end:
        raise ValueError("X_START must be smaller than X_END.")


def iter_files(source: Path) -> list[Path]:
    if not source.exists():
        raise FileNotFoundError(f"Source folder does not exist: {source}")
    return sorted(path for path in source.rglob("*") if path.is_file() and not path.name.startswith("."))


def crop_pixel_array(pixel_array: np.ndarray, left: int, right: int) -> np.ndarray:
    if pixel_array.ndim == 2:
        return pixel_array[:, left:right]
    if pixel_array.ndim == 3:
        return pixel_array[:, :, left:right]
    raise ValueError(f"Unsupported pixel array shape: {pixel_array.shape}")


def update_image_position_patient(ds: pydicom.Dataset, left_columns_removed: int) -> None:
    if not hasattr(ds, "ImagePositionPatient"):
        return
    if not hasattr(ds, "ImageOrientationPatient"):
        return
    if not hasattr(ds, "PixelSpacing"):
        return

    ipp = np.asarray(ds.ImagePositionPatient, dtype=float)
    iop = np.asarray(ds.ImageOrientationPatient, dtype=float)
    pixel_spacing = np.asarray(ds.PixelSpacing, dtype=float)

    if iop.shape[0] != 6 or pixel_spacing.shape[0] < 2:
        return

    # For pixel_array[:, x], x moves along the image row direction
    # (the first 3 values of ImageOrientationPatient).
    column_direction = iop[:3]
    column_spacing = float(pixel_spacing[1])
    shifted_ipp = ipp + left_columns_removed * column_spacing * column_direction
    ds.ImagePositionPatient = [str(value) for value in shifted_ipp]


def crop_dataset(
    ds: pydicom.Dataset,
    x_start: int,
    x_end: int,
    series_instance_uid: str,
    description_suffix: str,
) -> tuple[pydicom.Dataset, int, int]:
    pixel_array = ds.pixel_array
    width = int(pixel_array.shape[-1])
    left = x_start
    right = x_end

    if left < 0 or right > width or left >= right:
        raise ValueError(
            f"Invalid crop bounds for width {width}: left={left}, right={right}"
        )

    derived = ds.copy()
    cropped = crop_pixel_array(pixel_array, left, right)
    derived.Columns = int(cropped.shape[-1])
    derived.Rows = int(cropped.shape[-2]) if cropped.ndim == 3 else int(cropped.shape[0])
    update_image_position_patient(derived, left)
    derived.PixelData = np.ascontiguousarray(cropped).tobytes()
    derived.SeriesInstanceUID = series_instance_uid
    derived.SOPInstanceUID = generate_uid()
    if getattr(derived, "file_meta", None) is not None:
        derived.file_meta.MediaStorageSOPInstanceUID = derived.SOPInstanceUID

    if hasattr(derived, "SeriesDescription"):
        derived.SeriesDescription = f"{derived.SeriesDescription}{description_suffix}"
    else:
        derived.SeriesDescription = f"cropped{description_suffix}"

    derived.ImageType = ["DERIVED", "PRIMARY"]
    return derived, left, right


def main() -> int:
    validate_crop(X_START, X_END)

    files = iter_files(SOURCE_DIR)
    if not files:
        raise FileNotFoundError(f"No files found in source folder: {SOURCE_DIR}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    series_instance_uid = generate_uid()

    written = 0
    skipped = 0

    for path in files:
        relative_path = path.relative_to(SOURCE_DIR)
        output_path = OUTPUT_DIR / relative_path

        try:
            ds = pydicom.dcmread(path, force=True)
            pixel_array = ds.pixel_array
        except Exception as exc:
            skipped += 1
            print(f"SKIP {relative_path}: cannot read pixel data ({exc})")
            continue

        width = int(pixel_array.shape[-1])
        left = X_START
        right = X_END

        if left < 0 or right > width or left >= right:
            skipped += 1
            print(
                f"SKIP {relative_path}: invalid crop for width={width}, left={left}, right={right}"
            )
            continue

        cropped_ds, _, _ = crop_dataset(
            ds,
            x_start=X_START,
            x_end=X_END,
            series_instance_uid=series_instance_uid,
            description_suffix=SERIES_DESCRIPTION_SUFFIX,
        )

        print(
            f"{'PLAN' if DRY_RUN else 'WRITE'} {relative_path}: "
            f"columns {width} -> {cropped_ds.Columns} (x={left}:{right})"
        )

        if DRY_RUN:
            continue

        output_path.parent.mkdir(parents=True, exist_ok=True)
        cropped_ds.save_as(output_path, write_like_original=False)
        written += 1

    print(
        f"Done. {'Planned' if DRY_RUN else 'Wrote'} {written if not DRY_RUN else len(files) - skipped} file(s), skipped {skipped}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
