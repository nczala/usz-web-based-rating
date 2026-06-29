import { init as cornerstoneInit } from "@cornerstonejs/core";
import { init as dicomImageLoaderInit } from "@cornerstonejs/dicom-image-loader";
import {
    init as cornerstoneToolsInit,
    addTool,
    StackScrollTool,
    WindowLevelTool,
    ZoomTool,
    PanTool,
    CrosshairsTool,
} from "@cornerstonejs/tools";

let isCornerstoneInitialized = false;
let areToolsRegistered = false;

export async function initializeCornerstoneViewer() {
    if (!isCornerstoneInitialized) {
        await cornerstoneInit();
        await dicomImageLoaderInit();
        await cornerstoneToolsInit();
        isCornerstoneInitialized = true;
    }

    if (!areToolsRegistered) {
        addTool(StackScrollTool);
        addTool(WindowLevelTool);
        addTool(ZoomTool);
        addTool(PanTool);
        addTool(CrosshairsTool);
        areToolsRegistered = true;
    }
}
