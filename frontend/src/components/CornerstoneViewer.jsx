import { useEffect, useRef, useState } from 'react'
import {
    Enums,
    EVENTS,
    RenderingEngine,
    imageLoader,
    setUseCPURendering,
    init as cornerstoneInit,
} from '@cornerstonejs/core'
import {
    init as dicomImageLoaderInit,
} from '@cornerstonejs/dicom-image-loader'
import '@cornerstonejs/codec-libjpeg-turbo-8bit'

let isInitialized = false

function withTimeout(promise, timeoutMs, message) {
    let timeoutId

    const timeout = new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    })

    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId))
}

async function initializeCornerstone() {
    if (isInitialized) return

    setUseCPURendering(true)
    await cornerstoneInit()
    await dicomImageLoaderInit({
        maxWebWorkers: Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 2)),
    })

    isInitialized = true
}
export function CornerstoneViewer({ imageIds }) {
    const elementRef = useRef(null)
    const renderingEngineRef = useRef(null)
    const [status, setStatus] = useState('Initializing viewer...')

    useEffect(() => {
        if (!elementRef.current) return
        if (!imageIds || imageIds.length === 0) return

        let isCancelled = false
        const element = elementRef.current

        function handleImageRendered() {
            const canvas = element.querySelector('canvas')

            if (!isCancelled) {
                setStatus(
                    `Rendered ${imageIds.length} image${imageIds.length === 1 ? '' : 's'}; canvas ${
                        canvas ? `${canvas.width} x ${canvas.height}` : 'not found'
                    }`
                )
            }
        }

        element.addEventListener(EVENTS.IMAGE_RENDERED, handleImageRendered)

        async function render() {
            try {
                setStatus('Loading DICOM image...')
                await initializeCornerstone()

                if (isCancelled) return

                if (renderingEngineRef.current) {
                    renderingEngineRef.current.destroy()
                    renderingEngineRef.current = null
                }

                const renderingEngineId = `rendering-engine-${crypto.randomUUID()}`
                const viewportId = `viewport-${crypto.randomUUID()}`

                const renderingEngine = new RenderingEngine(renderingEngineId)
                renderingEngineRef.current = renderingEngine

                renderingEngine.enableElement({
                    viewportId,
                    element: elementRef.current,
                    type: Enums.ViewportType.STACK,
                })

                const viewport = renderingEngine.getViewport(viewportId)
                viewport.setUseCPURendering(true)

                const image = await withTimeout(
                    imageLoader.loadAndCacheImage(imageIds[0]),
                    15000,
                    `Timed out while loading ${imageIds[0]}`
                )

                if (isCancelled) return

                await viewport.setStack(imageIds, 0)
                viewport.resetProperties()
                viewport.setProperties({
                    voiRange: {
                        lower: image.minPixelValue,
                        upper: image.maxPixelValue,
                    },
                })
                viewport.resetCamera({
                    resetPan: true,
                    resetZoom: true,
                    resetToCenter: true,
                    resetAspectRatio: true,
                })

                viewport.render()

                window.requestAnimationFrame(() => {
                    if (isCancelled) return

                    const canvas = element.querySelector('canvas')
                    setStatus(
                        `Loaded ${image.width} x ${image.height}, min ${image.minPixelValue}, max ${image.maxPixelValue}; canvas ${
                            canvas ? `${canvas.width} x ${canvas.height}` : 'not found'
                        }`
                    )
                })
            } catch (error) {
                console.error('Cornerstone render error:', error)
                setStatus(error.message)
            }
        }

        render()

        return () => {
            isCancelled = true

            if (renderingEngineRef.current) {
                renderingEngineRef.current.destroy()
                renderingEngineRef.current = null
            }

            element.removeEventListener(EVENTS.IMAGE_RENDERED, handleImageRendered)
        }
    }, [imageIds])

    return (
        <section className="dicom-viewer">
            <div ref={elementRef} className="dicom-viewport" />
            <p className="dicom-status">{status}</p>
        </section>
    )
}
