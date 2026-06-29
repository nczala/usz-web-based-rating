import { useEffect, useMemo, useState } from "react";

import { Enums } from "@cornerstonejs/core";

import { SequenceViewportPanel } from "./components/SequenceViewportPanel";
import { useDualSequenceViewer } from "./hooks/useDualSequenceViewer";

import "./App.css";
import { getRating, saveRating } from "./api/ratings.js";
import { getUserQuestions, getUserState } from "./api/users.js";

const USER_ID = 1;
const FALLBACK_TOTAL_CASES = 59;

const orientationOptions = [
    { value: Enums.OrientationAxis.AXIAL, label: "Axial" },
    { value: Enums.OrientationAxis.SAGITTAL, label: "Sagittal" },
    { value: Enums.OrientationAxis.CORONAL, label: "Coronal" },
];

function getOptions(question) {
    return Object.entries(question)
        .filter(([key, value]) => /^a\d+$/.test(key) && value != null)
        .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(([, value]) => value);
}

function getSelectedAnswerKey(question, selectedValue) {
    const match = Object.entries(question)
        .filter(([key, value]) => /^a\d+$/.test(key) && value != null)
        .find(([, value]) => value === selectedValue);

    return match?.[0] ?? null;
}

function getCurrentOrderId(userState) {
    if (!userState || typeof userState !== "object") {
        return null;
    }

    const candidate =
        userState.last_order_id ??
        userState.current_order_id ??
        userState.currentOrderId ??
        userState.order_id ??
        userState.orderId ??
        userState.state ??
        null;

    return candidate == null ? null : Number(candidate);
}

function getCurrentCaseId(userState) {
    if (!userState || typeof userState !== "object") {
        return null;
    }

    const candidate =
        userState.last_case_id ??
        userState.current_case_id ??
        userState.currentCaseId ??
        userState.case_id ??
        userState.caseId ??
        null;

    return candidate == null ? null : Number(candidate);
}

function getTotalCases(userState, orderEntries) {
    const explicitTotal =
        userState?.number_of_cases ??
        userState?.total_orders ??
        userState?.total_order_count ??
        userState?.total_cases ??
        userState?.case_count ??
        null;

    if (explicitTotal != null) {
        return Number(explicitTotal);
    }

    if (orderEntries.length > 0) {
        return orderEntries.length;
    }

    return FALLBACK_TOTAL_CASES;
}

function getOrderEntries(userState) {
    const candidates = [
        userState?.orders,
        userState?.order_cases,
        userState?.orderCaseMap,
        userState?.user_order,
        userState?.order_map,
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const entries = candidate
                .map((entry) => ({
                    orderId: Number(
                        entry?.order ?? entry?.order_id ?? entry?.orderId ?? NaN
                    ),
                    caseId: Number(
                        entry?.case_id ?? entry?.caseId ?? entry?.case ?? NaN
                    ),
                }))
                .filter(
                    (entry) =>
                        Number.isFinite(entry.orderId) && Number.isFinite(entry.caseId)
                )
                .sort((a, b) => a.orderId - b.orderId);

            if (entries.length > 0) {
                return entries;
            }
        }

        if (candidate && typeof candidate === "object") {
            const entries = Object.entries(candidate)
                .map(([orderId, caseId]) => ({
                    orderId: Number(orderId),
                    caseId: Number(caseId),
                }))
                .filter(
                    (entry) =>
                        Number.isFinite(entry.orderId) && Number.isFinite(entry.caseId)
                )
                .sort((a, b) => a.orderId - b.orderId);

            if (entries.length > 0) {
                return entries;
            }
        }
    }

    return [];
}

function getCaseIdForOrder(orderEntries, orderId) {
    return (
        orderEntries.find((entry) => entry.orderId === Number(orderId))?.caseId ?? null
    );
}

function getAnsweredCount(questions, answers) {
    return questions.filter((question) => answers[question.question_nr]).length;
}

function formatQuestionLabel(questionNr) {
    if (typeof questionNr !== "string" || questionNr.length === 0) {
        return "Question";
    }

    return questionNr.toUpperCase();
}

function mapPersistedAnswerToValue(question, persistedAnswer) {
    if (persistedAnswer == null || persistedAnswer === "") {
        return null;
    }

    if (question[persistedAnswer] != null) {
        return question[persistedAnswer];
    }

    return getOptions(question).includes(persistedAnswer) ? persistedAnswer : null;
}

function normalizeAnswers(questions, persistedAnswers = {}) {
    return Object.fromEntries(
        questions
            .map((question) => [
                question.question_nr,
                mapPersistedAnswerToValue(
                    question,
                    persistedAnswers?.[question.question_nr]
                ),
            ])
            .filter(([, value]) => value != null)
    );
}

function areAnswersEqual(questions, leftAnswers, rightAnswers) {
    return questions.every(
        (question) =>
            (leftAnswers[question.question_nr] ?? null) ===
            (rightAnswers[question.question_nr] ?? null)
    );
}

function getProgressState(questions, answers, savedAnswers) {
    const hasSavedAnswers = Object.keys(savedAnswers).length > 0;
    const hasCurrentAnswers = Object.keys(answers).length > 0;

    if (hasSavedAnswers && areAnswersEqual(questions, answers, savedAnswers)) {
        return {
            label: "Saved",
            tone: "saved",
        };
    }

    if (hasCurrentAnswers && !areAnswersEqual(questions, answers, savedAnswers)) {
        return {
            label: "Modified, not saved yet",
            tone: "modified",
        };
    }

    return {
        label: "Not saved yet",
        tone: "unsaved",
    };
}

const panelConfigs = [
    {
        key: "left",
        title: "Tra Sequence",
        seriesName: "axial",
        viewportId: "LEFT_VIEWPORT",
        volumeId: "cornerstoneStreamingImageVolume:leftSequence",
        initialOrientation: Enums.OrientationAxis.AXIAL,
        isReversed: true,
    },
    {
        key: "right",
        title: "Sag Sequence",
        seriesName: "sagittal",
        viewportId: "RIGHT_VIEWPORT",
        volumeId: "cornerstoneStreamingImageVolume:rightSequence",
        initialOrientation: Enums.OrientationAxis.SAGITTAL,
        isReversed: false,
    },
];

function App() {
    const [userState, setUserState] = useState(null);
    const [orderEntries, setOrderEntries] = useState([]);
    const [questions, setQuestions] = useState([]);
    const [answers, setAnswers] = useState({});
    const [savedAnswers, setSavedAnswers] = useState({});
    const [currentOrderId, setCurrentOrderId] = useState(null);
    const [currentCaseId, setCurrentCaseId] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [saveSuccessMessage, setSaveSuccessMessage] = useState(null);

    async function loadCaseForOrder(orderId, options = {}) {
        const {
            preferredCaseId = null,
            nextQuestions = questions,
            nextOrderEntries = orderEntries,
        } = options;

        const rating = await getRating(USER_ID, orderId);
        const resolvedCaseId =
            preferredCaseId ??
            getCaseIdForOrder(nextOrderEntries, orderId) ??
            (rating?.case_id != null ? Number(rating.case_id) : null);

        if (resolvedCaseId == null) {
            throw new Error(
                `Could not resolve case for order ${orderId}. Expose the order-to-case mapping in /users/${USER_ID}.`
            );
        }

        const normalizedAnswers = normalizeAnswers(nextQuestions, rating?.answers ?? {});

        setCurrentOrderId(Number(orderId));
        setCurrentCaseId(resolvedCaseId);
        setAnswers(normalizedAnswers);
        setSavedAnswers(normalizedAnswers);
    }

    useEffect(() => {
        let isCancelled = false;

        async function loadSession() {
            try {
                setIsLoading(true);
                setLoadError(null);

                const [nextUserState, nextQuestions] = await Promise.all([
                    getUserState(USER_ID),
                    getUserQuestions(USER_ID),
                ]);

                if (isCancelled) {
                    return;
                }

                const nextOrderEntries = getOrderEntries(nextUserState);
                const initialOrderId = getCurrentOrderId(nextUserState);
                const initialCaseId = getCurrentCaseId(nextUserState);

                setUserState(nextUserState);
                setOrderEntries(nextOrderEntries);
                setQuestions(Array.isArray(nextQuestions) ? nextQuestions : []);

                if (initialOrderId != null) {
                    await loadCaseForOrder(initialOrderId, {
                        preferredCaseId: initialCaseId,
                        nextQuestions: Array.isArray(nextQuestions) ? nextQuestions : [],
                        nextOrderEntries,
                    });
                }
            } catch (error) {
                if (isCancelled) {
                    return;
                }

                console.error("Failed to load user session:", error);
                setLoadError(error.message);
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        }

        loadSession();

        return () => {
            isCancelled = true;
        };
    }, []);

    const { panels, handleReset } = useDualSequenceViewer(panelConfigs, currentCaseId);
    const answeredCount = useMemo(
        () => getAnsweredCount(questions, answers),
        [questions, answers]
    );
    const hasUnsavedChanges = useMemo(
        () => !areAnswersEqual(questions, answers, savedAnswers),
        [questions, answers, savedAnswers]
    );
    const progressState = useMemo(
        () => getProgressState(questions, answers, savedAnswers),
        [questions, answers, savedAnswers]
    );
    const totalCases = useMemo(
        () => getTotalCases(userState, orderEntries),
        [orderEntries, userState]
    );
    const canGoPrevious =
        !isLoading && !isSaving && currentOrderId != null && currentOrderId > 1;
    const canGoNext =
        !isLoading &&
        !isSaving &&
        !loadError &&
        questions.length > 0 &&
        answeredCount === questions.length &&
        currentOrderId != null &&
        currentOrderId < totalCases;
    const isSaveEnabled =
        !isLoading &&
        !loadError &&
        !isSaving &&
        questions.length > 0 &&
        answeredCount === questions.length &&
        currentCaseId != null &&
        currentOrderId != null &&
        hasUnsavedChanges;

    function handleAnswerChange(questionNr, value) {
        setSaveError(null);
        setSaveSuccessMessage(null);

        setAnswers((prev) => ({
            ...prev,
            [questionNr]: value,
        }));
    }

    async function handleNavigate(orderId, options = {}) {
        if (
            hasUnsavedChanges &&
            !window.confirm(
                "You have unsaved changes for this case. Switch cases and discard them?"
            )
        ) {
            return;
        }

        try {
            setIsLoading(true);
            setLoadError(null);
            setSaveError(null);
            setSaveSuccessMessage(null);

            await loadCaseForOrder(orderId, options);
        } catch (error) {
            console.error(`Failed to load order ${orderId}:`, error);
            setLoadError(error.message);
        } finally {
            setIsLoading(false);
        }
    }

    async function handleSaveAnswers() {
        if (!isSaveEnabled) {
            return;
        }

        setIsSaving(true);
        setSaveError(null);
        setSaveSuccessMessage(null);

        try {
            const payload = {
                userId: USER_ID,
                caseId: currentCaseId,
                answers: Object.fromEntries(
                    questions.map((question) => [
                        question.question_nr,
                        getSelectedAnswerKey(question, answers[question.question_nr]),
                    ])
                ),
            };

            await saveRating(USER_ID, currentOrderId, payload);
            setSavedAnswers(answers);
            setSaveSuccessMessage("Answers saved.");
        } catch (error) {
            console.error("Failed to save answers:", error);
            setSaveError(error.message);
        } finally {
            setIsSaving(false);
        }
    }

    return (
        <div className="app">
            <div className="app-header">
                <div>
                    <p className="eyebrow">Reader Session</p>
                    <h1>DICOM VIEWER</h1>
                </div>
                <div className="header-actions">
                    <div className="session-chip">{userState?.user_group ?? "Loading..."}</div>
                    <div className="session-chip">User {USER_ID}</div>
                    <button className="reset-button" type="button" onClick={handleReset}>
                        Reset View
                    </button>
                </div>
            </div>

            <div className="app-layout">
                <section className="main-panel">
                    <div className="info-strip">
                        <div className="info-card case-navigation-card">
                            <span className="info-label">Current case</span>
                            <div className="case-navigation-row">
                                <strong>
                                    Case {currentCaseId ?? "Unavailable"} · Order{" "}
                                    {currentOrderId ?? "-"} / {totalCases}
                                </strong>
                                <div className="case-navigation-actions">
                                    <button
                                        className="case-nav-button"
                                        type="button"
                                        disabled={!canGoPrevious}
                                        onClick={() =>
                                            handleNavigate(currentOrderId - 1)
                                        }
                                    >
                                        <span className="case-nav-arrow" aria-hidden="true">
                                            ←
                                        </span>
                                        <span>Previous case</span>
                                    </button>
                                    <button
                                        className="case-nav-button"
                                        type="button"
                                        disabled={!canGoNext}
                                        onClick={() =>
                                            handleNavigate(currentOrderId + 1)
                                        }
                                    >
                                        <span>Next case</span>
                                        <span className="case-nav-arrow" aria-hidden="true">
                                            →
                                        </span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="info-card">
                            <span className="info-label">Question progress</span>
                            <strong>
                                {answeredCount} / {questions.length}
                            </strong>
                            <div className="progress-state-row">
                                <span
                                    className={`progress-state-badge progress-state-${progressState.tone}`}
                                >
                                    {progressState.label}
                                </span>
                            </div>
                        </div>
                        <div className="info-card info-card-wide">
                            <span className="info-label">Controls</span>
                            <strong>
                                Wheel scroll, left drag window, right drag zoom, middle
                                drag pan
                            </strong>
                        </div>
                    </div>

                    <div className="viewer-column">
                        {panels.map((panel) => (
                            <SequenceViewportPanel
                                key={panel.key}
                                title={panel.title}
                                orientationOptions={orientationOptions}
                                defaultOrientation={panel.initialOrientation}
                                viewportRef={panel.viewportRef}
                                sliderRef={panel.sliderRef}
                                sliceLabelRef={panel.sliceLabelRef}
                                orientationRef={panel.orientationRef}
                                isLoading={panel.isLoading}
                                loadError={panel.loadError}
                                onSliderInput={panel.onSliderInput}
                                onOrientationChange={panel.onOrientationChange}
                            />
                        ))}
                    </div>
                </section>

                <aside className="questions-panel">
                    <div className="questions-panel-header">
                        <div>
                            <p className="eyebrow">Assessment</p>
                            <h2>Questions</h2>
                        </div>
                        <div className="questions-panel-actions">
                            <div className="question-count">
                                {answeredCount}/{questions.length}
                            </div>
                            <button
                                className="save-button"
                                type="button"
                                disabled={!isSaveEnabled}
                                onClick={handleSaveAnswers}
                            >
                                {isSaving ? "Saving..." : "Save"}
                            </button>
                        </div>
                    </div>

                    {saveError ? (
                        <div className="save-status save-status-error">{saveError}</div>
                    ) : null}

                    {saveSuccessMessage ? (
                        <div className="save-status save-status-success">
                            {saveSuccessMessage}
                        </div>
                    ) : null}

                    {isLoading ? (
                        <div className="questions-state-card">
                            <h3>Loading questions</h3>
                            <p>Fetching reader state and question set for user {USER_ID}.</p>
                        </div>
                    ) : null}

                    {!isLoading && loadError ? (
                        <div className="questions-state-card questions-state-card-error">
                            <h3>Could not load session</h3>
                            <p>{loadError}</p>
                        </div>
                    ) : null}

                    {!isLoading && !loadError && questions.length === 0 ? (
                        <div className="questions-state-card">
                            <h3>No questions available</h3>
                            <p>This user currently has no questions assigned.</p>
                        </div>
                    ) : null}

                    {!isLoading && !loadError ? (
                        <div className="questions-list">
                            {questions.map((question) => (
                                <section key={question.question_nr} className="question-card">
                                    <div className="question-card-header">
                                        <span className="question-badge">
                                            {formatQuestionLabel(question.question_nr)}
                                        </span>
                                        <h3>{question.question}</h3>
                                    </div>

                                    <div className="answer-list">
                                        {getOptions(question).map((option) => (
                                            <label
                                                key={option}
                                                className={`answer-option${
                                                    answers[question.question_nr] === option
                                                        ? " is-selected"
                                                        : ""
                                                }`}
                                            >
                                                <input
                                                    type="radio"
                                                    name={question.question_nr}
                                                    value={option}
                                                    checked={
                                                        answers[question.question_nr] === option
                                                    }
                                                    onChange={() =>
                                                        handleAnswerChange(
                                                            question.question_nr,
                                                            option
                                                        )
                                                    }
                                                />
                                                <span>{option}</span>
                                            </label>
                                        ))}
                                    </div>
                                </section>
                            ))}
                        </div>
                    ) : null}
                </aside>
            </div>
        </div>
    );
}

export default App;
