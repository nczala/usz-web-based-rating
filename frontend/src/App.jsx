import { useEffect, useMemo, useState } from "react";

import { Enums } from "@cornerstonejs/core";

import { SequenceViewportPanel } from "./components/SequenceViewportPanel";
import { useDualSequenceViewer } from "./hooks/useDualSequenceViewer";

import "./App.css";
import { getRating, saveRating } from "./api/ratings.js";
import {
    createUser,
    deleteUser,
    getUserByName,
    getUserGroups,
    getUserQuestions,
    getUsers,
    getUserState,
} from "./api/users.js";
import uszLogo from "./assets/usz-logo.jpg";

const FALLBACK_TOTAL_CASES = 59;

const orientationOptions = [
    { value: Enums.OrientationAxis.AXIAL, label: "Axial" },
    { value: Enums.OrientationAxis.SAGITTAL, label: "Sagittal" },
    { value: Enums.OrientationAxis.CORONAL, label: "Coronal" },
];

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

function getRouteState(pathname) {
    const segments = pathname.split("/").filter(Boolean);

    if (segments.length === 0) {
        return { type: "home" };
    }

    return {
        type: "user",
        username: decodeURIComponent(segments[0]),
    };
}

function navigateTo(pathname) {
    window.history.pushState({}, "", pathname);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

function useRouteState() {
    const [routeState, setRouteState] = useState(() =>
        getRouteState(window.location.pathname)
    );

    useEffect(() => {
        function handleLocationChange() {
            setRouteState(getRouteState(window.location.pathname));
        }

        window.addEventListener("popstate", handleLocationChange);

        return () => {
            window.removeEventListener("popstate", handleLocationChange);
        };
    }, []);

    return routeState;
}

function UserPicker() {
    const [users, setUsers] = useState([]);
    const [availableGroups, setAvailableGroups] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [newUserName, setNewUserName] = useState("");
    const [newUserGroup, setNewUserGroup] = useState("");
    const [isCreatingUser, setIsCreatingUser] = useState(false);
    const [createUserError, setCreateUserError] = useState(null);
    const [createUserSuccess, setCreateUserSuccess] = useState(null);
    const [deletingUserId, setDeletingUserId] = useState(null);
    const [deleteUserError, setDeleteUserError] = useState(null);
    const [deleteUserSuccess, setDeleteUserSuccess] = useState(null);

    useEffect(() => {
        let isCancelled = false;

        async function loadAvailableUsers() {
            try {
                setIsLoading(true);
                setLoadError(null);
                const [nextUsers, nextGroups] = await Promise.all([
                    getUsers(),
                    getUserGroups(),
                ]);

                if (isCancelled) {
                    return;
                }

                setUsers(Array.isArray(nextUsers) ? nextUsers : []);
                setAvailableGroups(Array.isArray(nextGroups) ? nextGroups : []);
            } catch (error) {
                if (!isCancelled) {
                    setLoadError(error.message);
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        }

        loadAvailableUsers();

        return () => {
            isCancelled = true;
        };
    }, []);

    useEffect(() => {
        if (availableGroups.length === 0) {
            return;
        }

        setNewUserGroup((currentGroup) =>
            currentGroup && availableGroups.includes(currentGroup)
                ? currentGroup
                : availableGroups[0]
        );
    }, [availableGroups]);

    const sortedUsers = useMemo(
        () =>
            [...users].sort(
                (left, right) => Number(left.user_id) - Number(right.user_id)
            ),
        [users]
    );

    async function handleCreateUser(event) {
        event.preventDefault();

        const trimmedName = newUserName.trim();

        if (!trimmedName) {
            setCreateUserError("Enter a user name.");
            return;
        }

        if (!newUserGroup) {
            setCreateUserError("Select a user group.");
            return;
        }

        try {
            setIsCreatingUser(true);
            setCreateUserError(null);
            setCreateUserSuccess(null);

            const createdUser = await createUser({
                name: trimmedName,
                group: newUserGroup,
            });

            setUsers((currentUsers) => [...currentUsers, createdUser]);
            setNewUserName("");
            setCreateUserSuccess(
                `Created ${createdUser.name} in ${createdUser.group} as user ${createdUser.user_id}.`
            );

            navigateTo(`/${encodeURIComponent(createdUser.slug)}`);
        } catch (error) {
            setCreateUserError(error.message);
        } finally {
            setIsCreatingUser(false);
        }
    }

    async function handleDeleteUser(user) {
        const confirmed = window.confirm(
            `Delete user "${user.name}" (user ${user.user_id}) and all corresponding files?`
        );

        if (!confirmed) {
            return;
        }

        try {
            setDeletingUserId(user.user_id);
            setDeleteUserError(null);
            setDeleteUserSuccess(null);
            setCreateUserSuccess(null);

            await deleteUser(user.user_id);

            setUsers((currentUsers) =>
                currentUsers.filter(
                    (currentUser) => String(currentUser.user_id) !== String(user.user_id)
                )
            );
            setDeleteUserSuccess(
                `Deleted ${user.name} and removed the corresponding user files.`
            );
        } catch (error) {
            setDeleteUserError(error.message);
        } finally {
            setDeletingUserId(null);
        }
    }

    return (
        <div className="app landing-app">
            <section className="landing-shell">
                <div className="landing-header">
                    <p className="eyebrow">Reader Session</p>
                    <h1>Select User</h1>
                    <p className="landing-copy">
                        Choose your username to open the rating session at its own URL.
                    </p>
                </div>

                <form className="landing-create-card" onSubmit={handleCreateUser}>
                    <div>
                        <p className="eyebrow">Add Reader</p>
                        <h2>Create User</h2>
                        <p className="landing-copy">
                            Add a new reader and open a dedicated rating URL immediately.
                        </p>
                    </div>

                    <div className="landing-form-row">
                        <label className="landing-field">
                            <span>Name</span>
                            <input
                                type="text"
                                value={newUserName}
                                onChange={(event) => setNewUserName(event.target.value)}
                                placeholder="Reader name"
                                autoComplete="off"
                            />
                        </label>

                        <label className="landing-field">
                            <span>Group</span>
                            <select
                                value={newUserGroup}
                                onChange={(event) => setNewUserGroup(event.target.value)}
                                disabled={availableGroups.length === 0}
                            >
                                {availableGroups.length === 0 ? (
                                    <option value="">No groups available</option>
                                ) : (
                                    availableGroups.map((group) => (
                                        <option key={group} value={group}>
                                            {group}
                                        </option>
                                    ))
                                )}
                            </select>
                        </label>
                    </div>

                    <div className="landing-form-actions">
                        <button
                            className="create-user-button"
                            type="submit"
                            disabled={isCreatingUser || availableGroups.length === 0}
                        >
                            {isCreatingUser ? "Creating..." : "Add user"}
                        </button>
                    </div>

                    {createUserError ? (
                        <div className="landing-state-card landing-state-card-error">
                            <h2>Could not create user</h2>
                            <p>{createUserError}</p>
                        </div>
                    ) : null}

                    {createUserSuccess ? (
                        <div className="landing-state-card">
                            <h2>User created</h2>
                            <p>{createUserSuccess}</p>
                        </div>
                    ) : null}

                    {deleteUserError ? (
                        <div className="landing-state-card landing-state-card-error">
                            <h2>Could not delete user</h2>
                            <p>{deleteUserError}</p>
                        </div>
                    ) : null}

                    {deleteUserSuccess ? (
                        <div className="landing-state-card">
                            <h2>User deleted</h2>
                            <p>{deleteUserSuccess}</p>
                        </div>
                    ) : null}
                </form>

                {isLoading ? (
                    <div className="landing-state-card">
                        <h2>Loading users</h2>
                        <p>Fetching the available usernames from the backend.</p>
                    </div>
                ) : null}

                {!isLoading && loadError ? (
                    <div className="landing-state-card landing-state-card-error">
                        <h2>Could not load users</h2>
                        <p>{loadError}</p>
                    </div>
                ) : null}

                {!isLoading && !loadError ? (
                    <div className="user-grid">
                        {sortedUsers.map((user) => (
                            <div key={user.slug} className="user-card">
                                <button
                                    className="delete-user-button"
                                    type="button"
                                    disabled={String(deletingUserId) === String(user.user_id)}
                                    onClick={() => handleDeleteUser(user)}
                                    aria-label={`Delete ${user.name}`}
                                    title={`Delete ${user.name}`}
                                >
                                    {String(deletingUserId) === String(user.user_id)
                                        ? "…"
                                        : "🗑"}
                                </button>

                                <button
                                    className="user-card-open"
                                    type="button"
                                    onClick={() =>
                                        navigateTo(`/${encodeURIComponent(user.slug)}`)
                                    }
                                >
                                    <span className="user-card-name">{user.name}</span>
                                    <span className="user-card-meta">
                                        {user.group} · user {user.user_id}
                                    </span>
                                    <span className="user-card-progress">
                                        {user.solved_cases ?? 0} / {user.total_cases ?? 0} cases processed
                                    </span>
                                    <span className="user-card-path">/{user.slug}</span>
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
            </section>
        </div>
    );
}

function UserRoute({ username }) {
    const [resolvedUser, setResolvedUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    useEffect(() => {
        let isCancelled = false;

        async function resolveUser() {
            try {
                setIsLoading(true);
                setLoadError(null);
                setResolvedUser(null);

                const nextUser = await getUserByName(username);
                if (!isCancelled) {
                    setResolvedUser(nextUser);
                }
            } catch (error) {
                if (!isCancelled) {
                    setLoadError(error.message);
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        }

        resolveUser();

        return () => {
            isCancelled = true;
        };
    }, [username]);

    if (isLoading) {
        return (
            <div className="app landing-app">
                <section className="landing-shell">
                    <div className="landing-state-card">
                        <h2>Opening session</h2>
                        <p>Resolving user route `/{username}`.</p>
                    </div>
                </section>
            </div>
        );
    }

    if (loadError || !resolvedUser) {
        return (
            <div className="app landing-app">
                <section className="landing-shell">
                    <div className="landing-state-card landing-state-card-error">
                        <h2>Could not resolve user</h2>
                        <p>{loadError ?? `Unknown user route: /${username}`}</p>
                    </div>
                    <button className="landing-back-link" type="button" onClick={() => navigateTo("/")}>
                        Back to user selection
                    </button>
                </section>
            </div>
        );
    }

    return <ViewerApp resolvedUser={resolvedUser} />;
}

function ViewerApp({ resolvedUser }) {
    const userId = String(resolvedUser.user_id);
    const [expandedPanelKey, setExpandedPanelKey] = useState(null);
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

        const rating = await getRating(userId, orderId);
        const resolvedCaseId =
            preferredCaseId ??
            getCaseIdForOrder(nextOrderEntries, orderId) ??
            (rating?.case_id != null ? Number(rating.case_id) : null);

        if (resolvedCaseId == null) {
            throw new Error(
                `Could not resolve case for order ${orderId}. Expose the order-to-case mapping in /users/${userId}.`
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
                    getUserState(userId),
                    getUserQuestions(userId),
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
    }, [userId]);

    useEffect(() => {
        if (expandedPanelKey == null) {
            return undefined;
        }

        function handleKeyDown(event) {
            if (event.key === "Escape") {
                setExpandedPanelKey(null);
            }
        }

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [expandedPanelKey]);

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
                userId,
                caseId: currentCaseId,
                answers: Object.fromEntries(
                    questions.map((question) => [
                        question.question_nr,
                        getSelectedAnswerKey(question, answers[question.question_nr]),
                    ])
                ),
            };

            await saveRating(userId, currentOrderId, payload);
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
                <div className="app-title">
                    <p className="eyebrow">Reader Session</p>
                    <h1>DICOM VIEWER</h1>
                </div>
                <div className="header-actions">
                    <div className="session-chip">{resolvedUser.name}</div>
                    <div className="session-chip">{userState?.user_group ?? "Loading..."}</div>
                    <div className="session-chip">User {userId}</div>
                    <button
                        className="hospital-logo"
                        type="button"
                        onClick={() => navigateTo("/")}
                        aria-label="Back to user selection"
                        title="Back to user selection"
                    >
                        <img className="hospital-logo-image" src={uszLogo} alt="USZ" />
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
                                    Case{" "}
                                    {currentOrderId ?? "-"} / {totalCases}
                                </strong>
                                <div className="case-navigation-actions">
                                    <button
                                        className="case-nav-button"
                                        type="button"
                                        disabled={!canGoPrevious}
                                        onClick={() => handleNavigate(currentOrderId - 1)}
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
                                        onClick={() => handleNavigate(currentOrderId + 1)}
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
                        <div className="info-card info-card-wide controls-card">
                            <button
                                className="reset-button controls-reset-button"
                                type="button"
                                onClick={handleReset}
                            >
                                Reset View
                            </button>
                            <span className="info-label">Controls</span>
                            <strong>
                                Wheel scroll, left drag window, right drag zoom, middle
                                drag pan, double-click expand
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
                                isExpanded={expandedPanelKey === panel.key}
                                onToggleExpand={() =>
                                    setExpandedPanelKey((currentKey) =>
                                        currentKey === panel.key ? null : panel.key
                                    )
                                }
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

                    {saveError ? <div className="save-status save-status-error">{saveError}</div> : null}
                    {saveSuccessMessage ? (
                        <div className="save-status save-status-success">
                            {saveSuccessMessage}
                        </div>
                    ) : null}

                    {isLoading ? (
                        <div className="questions-state-card">
                            <h3>Loading questions</h3>
                            <p>Fetching reader state and question set for user {userId}.</p>
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
                                                    checked={answers[question.question_nr] === option}
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

export default function App() {
    const routeState = useRouteState();

    if (routeState.type === "home") {
        return <UserPicker />;
    }

    return <UserRoute username={routeState.username} />;
}
