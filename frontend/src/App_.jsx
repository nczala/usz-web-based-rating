import { useEffect, useState } from 'react'
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader'
import { getCaseDicoms } from './api/cases'
import { CornerstoneViewer } from './components/CornerstoneViewer'
import './App_.css'

function App_() {
    const [imageIds, setImageIds] = useState([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState(null)

    useEffect(() => {
        getCaseDicoms(1)
            .then((dicomUrls) => {
                const loadedImageIds = dicomUrls.slice(0, 1).map((url) => {
                    const relativeUrl = new URL(url, window.location.origin)
                    return `wadouri:${relativeUrl.pathname}`
                })

                setImageIds(loadedImageIds)
            })
            .catch((error) => {
                console.error('Failed to load case DICOMs:', error)
                setError(error.message)
            })
            .finally(() => setIsLoading(false))
    }, [])

    function handleFileChange(event) {
        try {
            setError(null)

            const files = Array.from(event.target.files || [])

            if (files.length === 0) {
                setImageIds([])
                return
            }

            const loadedImageIds = files.map((file) =>
                cornerstoneDICOMImageLoader.wadouri.fileManager.add(file)
            )

            setImageIds(loadedImageIds)
        } catch (error) {
            console.error('Failed to load DICOM files:', error)
            setError(error.message)
        }
    }

    return (
        <main style={{ padding: 24 }}>
            <h1>DICOM Viewer</h1>

            <p>
                {isLoading
                    ? 'Loading predefined case DICOMs...'
                    : `Loaded ${imageIds.length} DICOM image${imageIds.length === 1 ? '' : 's'}.`}
            </p>

            <input
                type="file"
                multiple
                accept=".dcm,application/dicom"
                onChange={handleFileChange}
            />

            {error && <p style={{ color: 'red' }}>{error}</p>}

            {!isLoading && imageIds.length === 0 && (
                <p>Select one or more DICOM files.</p>
            )}

            {imageIds.length > 0 && (
                <CornerstoneViewer imageIds={imageIds} />
            )}
        </main>
    )
}

export default App_
