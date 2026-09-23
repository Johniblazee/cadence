(function () {
    const RATE_STEPS = ["-25%", "+0%", "+25%", "+50%"];
    const RATE_LABELS = {
        "-25%": "0.75×",
        "+0%": "1.0×",
        "+25%": "1.25×",
        "+50%": "1.5×"
    };

    const elements = {
        artifactCoverImage: document.getElementById("artifact-cover-image"),
        artifactCoverFallback: document.getElementById("artifact-cover-fallback"),
        artifactKicker: document.getElementById("artifact-kicker"),
        artifactTitle: document.getElementById("artifact-title"),
        artifactMeta: document.getElementById("artifact-meta"),
        primaryActionBtn: document.getElementById("primary-action-btn"),
        pauseBtn: document.getElementById("pause-btn"),
        stopBtn: document.getElementById("stop-btn"),
        voiceSelect: document.getElementById("voice-select"),
        rateRange: document.getElementById("rate-range"),
        rateReadout: document.getElementById("rate-readout"),
        backendUrlInput: document.getElementById("backend-url-input"),
        backendUrlSave: document.getElementById("backend-url-save"),
        clickModeToggle: document.getElementById("click-mode-toggle"),
        statusText: document.getElementById("status-text")
    };

    let activeTab = null;
    let activeTabId = null;
    let currentState = null;
    let primaryActionType = "START_READING_TOP";

    init().catch((error) => {
        setStatus(error.message || "Cadence popup failed to load.", true);
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type !== "STATE_UPDATED" || !message.state || message.state.tabId !== activeTabId) {
            return;
        }

        renderState(message.state);
    });

    async function init() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            throw new Error("No active tab is available.");
        }

        activeTab = tab;
        activeTabId = tab.id;
        renderTabMeta(tab);
        bindEvents();
        await loadVoices();
        await refreshState();
    }

    function bindEvents() {
        elements.primaryActionBtn.addEventListener("click", async () => {
            await sendAction(primaryActionType, primaryActionType === "START_READING_TOP"
                ? "Starting webpage reading..."
                : "Resuming playback...");
        });

        elements.pauseBtn.addEventListener("click", () => sendAction("PAUSE_READING", "Paused."));
        elements.stopBtn.addEventListener("click", () => sendAction("STOP_READING", "Stopped."));

        elements.voiceSelect.addEventListener("change", async () => {
            if (await updateSettings({ voiceName: elements.voiceSelect.value })) {
                setStatus("Voice updated.");
            }
        });

        elements.rateRange.addEventListener("input", () => {
            const rate = RATE_STEPS[Number(elements.rateRange.value)] || "+0%";
            elements.rateReadout.textContent = RATE_LABELS[rate];
        });

        elements.rateRange.addEventListener("change", async () => {
            const rate = RATE_STEPS[Number(elements.rateRange.value)] || "+0%";
            if (await updateSettings({ rate })) {
                setStatus("Speed updated.");
            }
        });

        elements.backendUrlSave.addEventListener("click", async () => {
            const backendBaseUrl = normalizeBackendUrlInput(elements.backendUrlInput.value);
            if (backendBaseUrl == null) {
                setStatus("Enter a valid backend URL.", true);
                return;
            }
            if (!(await updateSettings({ backendBaseUrl }))) {
                return;
            }
            try {
                await loadVoices();
                setStatus("Backend URL updated.");
            } catch (error) {
                setStatus(error.message || "Voice loading failed.", true);
            }
        });

        elements.backendUrlInput.addEventListener("keydown", async (event) => {
            if (event.key !== "Enter") {
                return;
            }

            event.preventDefault();
            const backendBaseUrl = normalizeBackendUrlInput(elements.backendUrlInput.value);
            if (backendBaseUrl == null) {
                setStatus("Enter a valid backend URL.", true);
                return;
            }
            if (!(await updateSettings({ backendBaseUrl }))) {
                return;
            }
            try {
                await loadVoices();
                setStatus("Backend URL updated.");
            } catch (error) {
                setStatus(error.message || "Voice loading failed.", true);
            }
        });

        elements.clickModeToggle.addEventListener("change", async () => {
            if (await updateSettings({ clickMode: elements.clickModeToggle.checked })) {
                setStatus(elements.clickModeToggle.checked ? "Click-to-read enabled." : "Click-to-read disabled.");
            }
        });
    }

    async function loadVoices() {
        const response = await chrome.runtime.sendMessage({ type: "GET_BACKEND_VOICES" });
        if (!response || !response.ok) {
            throw new Error(response?.error || "Could not load Edge TTS voices from the configured backend.");
        }

        elements.voiceSelect.innerHTML = "";
        response.voices.forEach((voice) => {
            const option = document.createElement("option");
            option.value = voice.name;
            option.textContent = `${voice.name} (${voice.locale})`;
            elements.voiceSelect.appendChild(option);
        });
    }

    async function refreshState() {
        const response = await chrome.runtime.sendMessage({
            type: "GET_TAB_STATE",
            tabId: activeTabId
        });

        if (!response || !response.ok) {
            throw new Error(response?.error || "Could not load tab state.");
        }

        renderState(response.state);
    }

    async function sendAction(type, successMessage) {
        const response = await chrome.runtime.sendMessage({ type, tabId: activeTabId });
        if (!response || !response.ok) {
            setStatus(response?.error || "That action could not be completed.", true);
            return;
        }

        renderState(response.state);
        setStatus(successMessage);
    }

    async function updateSettings(settings) {
        const response = await chrome.runtime.sendMessage({
            type: "UPDATE_SETTINGS",
            tabId: activeTabId,
            settings
        });

        if (!response || !response.ok) {
            setStatus(response?.error || "Settings update failed.", true);
            return false;
        }

        renderState(response.state);
        return true;
    }

    function renderTabMeta(tab) {
        const title = tab?.title || "Current webpage";
        const hostname = tab?.url ? safeHostname(tab.url) : "Current webpage";

        elements.artifactTitle.textContent = title;
        elements.artifactMeta.textContent = `${hostname} · Configured Edge TTS backend`;

        if (tab?.favIconUrl) {
            elements.artifactCoverImage.src = tab.favIconUrl;
            elements.artifactCoverImage.hidden = false;
            elements.artifactCoverFallback.hidden = true;
        } else {
            elements.artifactCoverImage.hidden = true;
            elements.artifactCoverFallback.hidden = false;
        }
    }

    function renderState(state) {
        if (!state) {
            return;
        }

        currentState = state;
        renderTabMeta(activeTab);

        elements.voiceSelect.value = state.voiceName || "en-US-AriaNeural";
        setRateUI(state.rate || "+0%");
        elements.backendUrlInput.value = state.backendBaseUrl || "";
        elements.clickModeToggle.checked = Boolean(state.clickMode);

        if (state.lastError) {
            elements.artifactKicker.textContent = "Playback issue";
            setPrimaryAction("START_READING_TOP", "Initiate playback", false);
            elements.pauseBtn.disabled = true;
            elements.stopBtn.disabled = !state.hasDocumentText;
            setStatus(state.lastError, true);
            return;
        }

        if (state.isSpeaking) {
            elements.artifactKicker.textContent = "Currently reading";
            setPrimaryAction("START_READING_TOP", "Playback active", true);
            elements.pauseBtn.disabled = false;
            elements.stopBtn.disabled = false;
            setStatus("Reading this page now with Edge TTS.");
            return;
        }

        if (state.isPaused) {
            elements.artifactKicker.textContent = "Playback paused";
            setPrimaryAction("RESUME_READING", "Resume playback", false);
            elements.pauseBtn.disabled = true;
            elements.stopBtn.disabled = false;
            setStatus("Paused at the current reading position.");
            return;
        }

        if (state.hasDocumentText && state.currentOffset > 0) {
            elements.artifactKicker.textContent = "Ready to continue";
            setPrimaryAction("RESUME_READING", "Resume playback", false);
            elements.pauseBtn.disabled = true;
            elements.stopBtn.disabled = false;
            setStatus("Ready to resume from the last reading position.");
            return;
        }

        elements.artifactKicker.textContent = "Current page";
        setPrimaryAction("START_READING_TOP", "Initiate playback", false);
        elements.pauseBtn.disabled = true;
        elements.stopBtn.disabled = true;
        setStatus("Open a webpage and start reading.");
    }

    function setPrimaryAction(actionType, label, disabled) {
        primaryActionType = actionType;
        elements.primaryActionBtn.textContent = label;
        elements.primaryActionBtn.disabled = Boolean(disabled);
    }

    function setRateUI(rate) {
        const stepIndex = Math.max(0, RATE_STEPS.indexOf(rate));
        const safeRate = RATE_STEPS[stepIndex] || "+0%";
        elements.rateRange.value = String(stepIndex);
        elements.rateReadout.textContent = RATE_LABELS[safeRate];
    }

    function safeHostname(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch (error) {
            return "Current webpage";
        }
    }

    function normalizeBackendUrlInput(value) {
        const trimmed = (value || "").trim();
        if (!trimmed) {
            return "";
        }

        const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        try {
            return new URL(candidate).toString().replace(/\/$/, "");
        } catch (error) {
            return null;
        }
    }

    function setStatus(message, isError) {
        elements.statusText.textContent = message;
        elements.statusText.style.color = isError ? "#8d1f11" : "";
    }
})();
