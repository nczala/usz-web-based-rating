import { useEffect, useRef, useState } from "react";

import {
    RenderingEngine,
    Enums,
    cache,
    volumeLoader,
    setVolumesForViewports,
    utilities,
} from "@cornerstonejs/core";
import {
    ToolGroupManager,
    StackScrollTool,
    WindowLevelTool,
    ZoomTool,
    PanTool,
    CrosshairsTool,
    Enums as ToolsEnums,
} from "@cornerstonejs/tools";

import {
    getDicomSeries,
    getSeriesImageIds,
    getInitialVoiRange,
} from "../api/dicomSeries";
import { initializeCornerstoneViewer } from "../lib/cornerstoneViewer";

const renderingEngineId = "engine";
const toolGroupId = "toolGroup";

function destroyToolGroup() {
    if (ToolGroupManager.getToolGroup(toolGroupId)) {
        ToolGroupManager.destroyToolGroup(toolGroupId);
    }
}

function releasePanelVolumes(panels) {
    for (const panel of Object.values(panels)) {
        if (!panel?.volumeId) {
            continue;
        }

        cache.getVolume(panel.volumeId)?.decache?.(true);
        cache.removeVolumeLoadObject(panel.volumeId);
    }
}

function getCaseVolumeId(baseVolumeId, caseId, loadId) {
    return `${baseVolumeId}:case-${caseId}:load-${loadId}`;
}

function getMiddleIndex(length) {
    return Math.max(0, Math.floor(length / 2));
}

function createPanelStatuses(panelConfigs, isLoading) {
    return Object.fromEntries(
        panelConfigs.map((config) => [config.key, { isLoading, loadError: null }])
    );
}

function toDisplayedSliceIndex(index, total, isReversed = false) {
    if (!isReversed) {
        return index;
    }

    return Math.max(0, total - 1 - index);
}

function toVolumeSliceIndex(index, total, isReversed = false) {
    return toDisplayedSliceIndex(index, total, isReversed);
}

function updateSliceControl(panel, index, total) {
    const displayedIndex = toDisplayedSliceIndex(index, total, panel.isReversed);

    if (panel.sliderRef.current) {
        panel.sliderRef.current.max = String(Math.max(total - 1, 0));
        panel.sliderRef.current.value = String(displayedIndex);
    }

    if (panel.sliceLabelRef.current) {
        panel.sliceLabelRef.current.textContent =
            total > 0 ? `${displayedIndex + 1} / ${total}` : "0 / 0";
    }
}

async function configureViewport(panel, sliceIndex = panel.initialSliceIndex) {
    panel.viewport.setOrientation(panel.initialOrientation);

    if (panel.initialVoiRange) {
        panel.viewport.setProperties({
            voiRange: panel.initialVoiRange,
        });
    }

    panel.viewport.resetCamera();
    panel.viewport.render();

    await utilities.jumpToSlice(panel.elementRef.current, {
        imageIndex: sliceIndex,
        volumeId: panel.volumeId,
    });

    panel.viewport.render();
}

export function useDualSequenceViewer(panelConfigs, caseId) {
    const [panelStatuses, setPanelStatuses] = useState(() =>
        createPanelStatuses(panelConfigs, caseId != null)
    );
    const leftViewportElementRef = useRef(null);
    const rightViewportElementRef = useRef(null);
    const leftSliderRef = useRef(null);
    const rightSliderRef = useRef(null);
    const leftSliceLabelRef = useRef(null);
    const rightSliceLabelRef = useRef(null);
    const leftOrientationRef = useRef(null);
    const rightOrientationRef = useRef(null);

    const renderingEngineRef = useRef(null);
    const runtimePanelsRef = useRef({});
    const resetViewersRef = useRef(async () => {});
    const isSyncingVoiRef = useRef(false);
    const resizeObserverRef = useRef(null);
    const resizeFrameRef = useRef(null);
    const loadIdRef = useRef(0);
    const panelRefs = {
        left: {
            elementRef: leftViewportElementRef,
            sliderRef: leftSliderRef,
            sliceLabelRef: leftSliceLabelRef,
            orientationRef: leftOrientationRef,
        },
        right: {
            elementRef: rightViewportElementRef,
            sliderRef: rightSliderRef,
            sliceLabelRef: rightSliceLabelRef,
            orientationRef: rightOrientationRef,
        },
    };

    useEffect(() => {
        let cleanupInteractions = () => {};
        let cleanupResizeHandling = () => {};

        function scheduleResize() {
            if (resizeFrameRef.current != null) {
                return;
            }

            resizeFrameRef.current = window.requestAnimationFrame(() => {
                resizeFrameRef.current = null;

                const renderingEngine = renderingEngineRef.current;

                if (!renderingEngine) {
                    return;
                }

                renderingEngine.resize(true, true);
            });
        }

        function getVoiRange(panel) {
            return panel.viewport?.getProperties?.().voiRange ?? null;
        }

        function hasSameVoiRange(leftRange, rightRange) {
            if (!leftRange && !rightRange) {
                return true;
            }

            if (!leftRange || !rightRange) {
                return false;
            }

            return (
                leftRange.lower === rightRange.lower && leftRange.upper === rightRange.upper
            );
        }

        function syncWindowing(sourcePanel) {
            if (isSyncingVoiRef.current) {
                return;
            }

            const targetPanel = Object.values(runtimePanelsRef.current).find(
                (panel) => panel.key !== sourcePanel.key
            );

            if (!targetPanel) {
                return;
            }

            const sourceVoiRange = getVoiRange(sourcePanel);
            const targetVoiRange = getVoiRange(targetPanel);

            if (!sourceVoiRange || hasSameVoiRange(sourceVoiRange, targetVoiRange)) {
                return;
            }

            isSyncingVoiRef.current = true;

            try {
                targetPanel.viewport.setProperties({
                    ...targetPanel.viewport.getProperties(),
                    voiRange: sourceVoiRange,
                });
                targetPanel.viewport.render();
            } finally {
                isSyncingVoiRef.current = false;
            }
        }

        async function run() {
            const loadId = ++loadIdRef.current;

            if (caseId == null) {
                destroyToolGroup();
                renderingEngineRef.current?.destroy?.();
                renderingEngineRef.current = null;
                releasePanelVolumes(runtimePanelsRef.current);
                runtimePanelsRef.current = {};
                resetViewersRef.current = async () => {};
                setPanelStatuses(createPanelStatuses(panelConfigs, false));
                return;
            }

            setPanelStatuses(createPanelStatuses(panelConfigs, true));

            try {
                destroyToolGroup();
                renderingEngineRef.current?.destroy?.();
                renderingEngineRef.current = null;
                releasePanelVolumes(runtimePanelsRef.current);
                runtimePanelsRef.current = {};
                resetViewersRef.current = async () => {};

                await initializeCornerstoneViewer();

                const loadedPanels = await Promise.all(
                    panelConfigs.map(async (config) => {
                        try {
                            const series = await getDicomSeries(caseId, config.seriesName);

                            return {
                                ...config,
                                ...panelRefs[config.key],
                                volumeId: getCaseVolumeId(config.volumeId, caseId, loadId),
                                imageIds: getSeriesImageIds(series),
                                initialSliceIndex: getMiddleIndex(series.length),
                                initialVoiRange: getInitialVoiRange(series),
                            };
                        } catch (error) {
                            setPanelStatuses((prev) => ({
                                ...prev,
                                [config.key]: {
                                    isLoading: false,
                                    loadError: error.message,
                                },
                            }));
                            throw error;
                        }
                    })
                );

                if (loadId !== loadIdRef.current) {
                    return;
                }

                const renderingEngine = new RenderingEngine(renderingEngineId);
                renderingEngineRef.current = renderingEngine;

                renderingEngine.setViewports(
                    loadedPanels.map((panel) => ({
                        viewportId: panel.viewportId,
                        element: panel.elementRef.current,
                        type: Enums.ViewportType.ORTHOGRAPHIC,
                        defaultOptions: {
                            orientation: panel.initialOrientation,
                        },
                    }))
                );

                for (const panel of loadedPanels) {
                    const volume = await volumeLoader.createAndCacheVolume(panel.volumeId, {
                        imageIds: panel.imageIds,
                    });

                    await volume.load();

                    if (loadId !== loadIdRef.current) {
                        renderingEngine.destroy?.();
                        return;
                    }

                    await setVolumesForViewports(
                        renderingEngine,
                        [{ volumeId: panel.volumeId }],
                        [panel.viewportId]
                    );

                    panel.viewport = renderingEngine.getViewport(panel.viewportId);
                }

                if (loadId !== loadIdRef.current) {
                    renderingEngine.destroy?.();
                    return;
                }

                runtimePanelsRef.current = Object.fromEntries(
                    loadedPanels.map((panel) => [panel.key, panel])
                );

                for (const panel of loadedPanels) {
                    await configureViewport(panel);

                    setPanelStatuses((prev) => ({
                        ...prev,
                        [panel.key]: {
                            isLoading: false,
                            loadError: null,
                        },
                    }));

                    if (panel.orientationRef.current) {
                        panel.orientationRef.current.value = panel.initialOrientation;
                    }
                }

                const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

                toolGroup.addTool(StackScrollTool.toolName);
                toolGroup.addTool(WindowLevelTool.toolName);
                toolGroup.addTool(ZoomTool.toolName);
                toolGroup.addTool(PanTool.toolName);
                toolGroup.addTool(CrosshairsTool.toolName, {
                    configuration: {
                        viewportIndicators: true,
                    },
                });

                for (const panel of loadedPanels) {
                    toolGroup.addViewport(panel.viewportId, renderingEngineId);
                }

                toolGroup.setToolActive(StackScrollTool.toolName, {
                    bindings: [{ mouseButton: ToolsEnums.MouseBindings.Wheel }],
                });
                toolGroup.setToolActive(WindowLevelTool.toolName, {
                    bindings: [{ mouseButton: ToolsEnums.MouseBindings.Primary }],
                });
                toolGroup.setToolActive(ZoomTool.toolName, {
                    bindings: [{ mouseButton: ToolsEnums.MouseBindings.Secondary }],
                });
                toolGroup.setToolActive(PanTool.toolName, {
                    bindings: [{ mouseButton: ToolsEnums.MouseBindings.Auxiliary }],
                });
                toolGroup.setToolEnabled(CrosshairsTool.toolName);

                const refreshControls = () => {
                    for (const panel of Object.values(runtimePanelsRef.current)) {
                        updateSliceControl(
                            panel,
                            panel.viewport.getCurrentImageIdIndex(panel.volumeId),
                            panel.viewport.getNumberOfSlices()
                        );
                    }
                };

                resetViewersRef.current = async () => {
                    for (const panel of Object.values(runtimePanelsRef.current)) {
                        await configureViewport(panel);

                        if (panel.orientationRef.current) {
                            panel.orientationRef.current.value = panel.initialOrientation;
                        }
                    }

                    refreshControls();
                };

                const onViewportRendered = (panel) => {
                    syncWindowing(panel);
                    refreshControls();
                };

                for (const panel of loadedPanels) {
                    const handlePanelRendered = () => onViewportRendered(panel);
                    panel.onViewportRendered = handlePanelRendered;

                    panel.elementRef.current.addEventListener(
                        Enums.Events.IMAGE_RENDERED,
                        handlePanelRendered
                    );
                }

                cleanupInteractions = () => {
                    for (const panel of loadedPanels) {
                        panel.elementRef.current?.removeEventListener(
                            Enums.Events.IMAGE_RENDERED,
                            panel.onViewportRendered
                        );
                    }
                };

                const resizeObserver = new ResizeObserver(() => {
                    scheduleResize();
                });

                resizeObserverRef.current = resizeObserver;

                for (const panel of loadedPanels) {
                    if (panel.elementRef.current) {
                        resizeObserver.observe(panel.elementRef.current);
                    }
                }

                window.addEventListener("resize", scheduleResize);

                cleanupResizeHandling = () => {
                    window.removeEventListener("resize", scheduleResize);
                    resizeObserver.disconnect();
                    resizeObserverRef.current = null;

                    if (resizeFrameRef.current != null) {
                        window.cancelAnimationFrame(resizeFrameRef.current);
                        resizeFrameRef.current = null;
                    }
                };

                refreshControls();
            } catch (error) {
                setPanelStatuses((prev) =>
                    Object.fromEntries(
                        panelConfigs.map((config) => [
                            config.key,
                            {
                                isLoading: false,
                                loadError: prev[config.key]?.loadError ?? error.message,
                            },
                        ])
                    )
                );
                throw error;
            }
        }

        run().catch(console.error);

        return () => {
            loadIdRef.current += 1;
            cleanupInteractions();
            cleanupResizeHandling();

            destroyToolGroup();

            renderingEngineRef.current?.destroy?.();
            renderingEngineRef.current = null;
            releasePanelVolumes(runtimePanelsRef.current);
            runtimePanelsRef.current = {};
            resetViewersRef.current = async () => {};
        };
    }, [caseId, panelConfigs]);

    async function handleSliderInput(panelKey, rawValue) {
        const panel = runtimePanelsRef.current[panelKey];
        const nextIndex = Number(rawValue);

        if (!panel || Number.isNaN(nextIndex)) {
            return;
        }

        await utilities.jumpToSlice(panel.elementRef.current, {
            imageIndex: toVolumeSliceIndex(
                nextIndex,
                panel.viewport.getNumberOfSlices(),
                panel.isReversed
            ),
            volumeId: panel.volumeId,
        });

        panel.viewport.render();
    }

    async function handleOrientationChange(panelKey, orientation) {
        const panel = runtimePanelsRef.current[panelKey];

        if (!panel) {
            return;
        }

        panel.viewport.setOrientation(orientation);
        panel.viewport.resetCamera();
        panel.viewport.render();

        await utilities.jumpToSlice(panel.elementRef.current, {
            imageIndex: getMiddleIndex(panel.viewport.getNumberOfSlices()),
            volumeId: panel.volumeId,
        });

        panel.viewport.render();
    }

    return {
        panels: panelConfigs.map((config) => ({
            ...config,
            viewportRef: panelRefs[config.key].elementRef,
            sliderRef: panelRefs[config.key].sliderRef,
            sliceLabelRef: panelRefs[config.key].sliceLabelRef,
            orientationRef: panelRefs[config.key].orientationRef,
            isLoading: panelStatuses[config.key]?.isLoading ?? false,
            loadError: panelStatuses[config.key]?.loadError ?? null,
            onSliderInput: (value) => handleSliderInput(config.key, value),
            onOrientationChange: (value) => handleOrientationChange(config.key, value),
        })),
        handleReset: () => resetViewersRef.current(),
    };
}
