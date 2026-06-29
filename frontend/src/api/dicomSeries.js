const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000";

async function fetchJson(path) {
    const response = await fetch(`${BACKEND_URL}${path}`);

    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
    }

    return response.json();
}

export async function getDicomSeries(caseId, seriesName) {
    return fetchJson(`/dicom-series/case/${caseId}/${seriesName}`);
}

export function getSeriesImageIds(series) {
    return series.map((item) => `wadouri:${BACKEND_URL}${encodeURI(item.url)}`);
}

export function getInitialVoiRange(series) {
    const firstItem = series[0];

    if (!firstItem) {
        return null;
    }

    if (
        Number.isFinite(firstItem.displayRangeLower) &&
        Number.isFinite(firstItem.displayRangeUpper)
    ) {
        return {
            lower: firstItem.displayRangeLower,
            upper: firstItem.displayRangeUpper,
        };
    }

    return {
        lower: firstItem.windowCenter - firstItem.windowWidth / 2,
        upper: firstItem.windowCenter + firstItem.windowWidth / 2,
    };
}
