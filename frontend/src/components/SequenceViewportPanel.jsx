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
    isExpanded,
    onToggleExpand,
}) {
    return (
        <div className={`viewer-panel${isExpanded ? " is-expanded" : ""}`}>
            <div className="panel-header">
                <h2>{title}</h2>
                <div className="panel-header-actions">
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
                    <button
                        className={`expand-button${isExpanded ? " is-active" : ""}`}
                        type="button"
                        onClick={onToggleExpand}
                        aria-pressed={isExpanded}
                        aria-label={isExpanded ? `Close enlarged ${title}` : `Enlarge ${title}`}
                        title={isExpanded ? "Close enlarged view" : "Enlarge view"}
                    >
                        <span className="expand-button-icon" aria-hidden="true">
                            {isExpanded ? "×" : "⤢"}
                        </span>
                    </button>
                </div>
            </div>

            <div
                className="viewport-wrapper"
                onDoubleClick={onToggleExpand}
                title="Double-click to expand"
            >
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
