export function SequenceViewportPanel({
    title,
    orientationOptions,
    defaultOrientation,
    viewportRef,
    sliderRef,
    sliceLabelRef,
    orientationRef,
    isLoading,
    loadError,
    onSliderInput,
    onOrientationChange,
}) {
    return (
        <div className="viewer-panel">
            <div className="panel-header">
                <h2>{title}</h2>
                <label className="orientation-control">
                    <span>View</span>
                    <select
                        ref={orientationRef}
                        className="orientation-select"
                        defaultValue={defaultOrientation}
                        onChange={(e) => onOrientationChange(e.target.value)}
                    >
                        {orientationOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <div className="viewport-wrapper">
                <div
                    ref={viewportRef}
                    className="viewport"
                    onContextMenu={(e) => e.preventDefault()}
                />
                {(isLoading || loadError) && (
                    <div className="viewport-overlay" role="status" aria-live="polite">
                        {isLoading ? (
                            <>
                                <div className="viewport-spinner" aria-hidden="true" />
                                <p className="viewport-overlay-label">Loading DICOMs...</p>
                            </>
                        ) : (
                            <p className="viewport-overlay-label">{loadError}</p>
                        )}
                    </div>
                )}
            </div>

            <div className="slice-control">
                <input
                    ref={sliderRef}
                    className="slice-slider"
                    type="range"
                    min="0"
                    max="0"
                    defaultValue="0"
                    onInput={(e) => onSliderInput(e.target.value)}
                />
                <span ref={sliceLabelRef} className="slice-label">
                    0 / 0
                </span>
            </div>
        </div>
    );
}
