const DEFAULT_BACKEND_BASE_URL = "https://cadence-fm4s.onrender.com";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const CONTENT_SCRIPT_FILES = ["content.js"];
const ACTIVE_TAB_STORAGE_KEY = "runtime:activeSpeechTabId";
const TAB_STATE_STORAGE_PREFIX = "runtime:tabState:";
const DEFAULT_SETTINGS = {
    backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
    voiceName: "en-US-AriaNeural",
    rate: "+0%",
    clickMode: false,
    dockAlwaysOn: true
};
const VALID_RATES = new Set(["-25%", "+0%", "+25%", "+50%"]);
const VALID_SOURCE_KINDS = new Set(["page", "paste", "selection"]);
const VOICE_CACHE_TTL_MS = 60 * 60 * 1000;

const tabStates = new Map();
let activeSpeechTabId = null;
let offscreenCreation = null;


chrome.runtime.onInstalled.addListener(async () => {
    const stored = await storageLocalGet(DEFAULT_SETTINGS);
    await storageLocalSet({ ...DEFAULT_SETTINGS, ...stored });

    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: "cadence", title: "Cadence", contexts: ["page", "selection"] });
    chrome.contextMenus.create({ id: "cadence-read-from-here", parentId: "cadence", title: "Read from here", contexts: ["page", "selection"] });
    chrome.contextMenus.create({ id: "cadence-continue-from-here", parentId: "cadence", title: "Continue from here", contexts: ["page", "selection"], visible: false });
    chrome.contextMenus.create({ id: "cadence-read-selection", parentId: "cadence", title: "Read selection only", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "cadence-send-to-paste", parentId: "cadence", title: "Send to paste box", contexts: ["selection"] });
});


chrome.tabs.onRemoved.addListener((tabId) => {
    void cleanupRemovedTab(tabId);
});


chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenuClick(info, tab);
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === "offscreen") {
        return undefined;
    }

    handleMessage(message, sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
});


chrome.commands.onCommand.addListener((command) => {
    void handleCommand(command).catch((error) => {
        console.error("Cadence command failed:", error);
    });
});


async function handleMessage(message, sender) {
    const tabId = message.tabId || sender.tab?.id;

    switch (message.type) {
        case "CONTENT_READY":
            if (!tabId) {
                return { state: null };
            }
            await syncTabStateWithOffscreen(tabId);
            return { state: await getSerializableState(tabId) };

        case "GET_TAB_STATE":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await syncTabStateWithOffscreen(tabId);
            return { state: await getSerializableState(tabId) };

        case "GET_BACKEND_VOICES":
            return { voices: await fetchBackendVoices() };

        case "START_READING_TOP":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await refreshDocumentText(tabId);
            await startSpeech(tabId, 0, { autoplay: true });
            return { state: await getSerializableState(tabId) };

        case "PAGE_CLICK_READING_REQUEST":
            if (!tabId) {
                throw new Error("No tab available for click-to-read.");
            }
            await setDocumentText(tabId, message.text || "");
            await startSpeech(tabId, Number(message.offset) || 0, { autoplay: true });
            return { state: await getSerializableState(tabId) };

        case "READ_TEXT": {
            if (!tabId) {
                throw new Error("No tab available.");
            }
            const text = typeof message.text === "string" ? message.text : "";
            if (!text.trim()) {
                throw new Error("Nothing to read.");
            }
            // Snapshot first: if the backend refuses the new session, the old page session keeps
            // playing and must keep its own text, source and offset.
            const prior = await ensureTabState(tabId);
            const previous = { text: prior.text, sourceKind: prior.sourceKind, currentOffset: prior.currentOffset };
            await setDocumentText(tabId, text, message.source === "selection" ? "selection" : "paste");
            try {
                await startSpeech(tabId, 0, { autoplay: true });
            } catch (error) {
                Object.assign(prior, previous);
                await persistTabState(tabId, prior);
                throw error;
            }
            return { state: await getSerializableState(tabId) };
        }

        case "PAUSE_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await pauseSpeech(tabId);
            return { state: await getSerializableState(tabId) };

        case "RESUME_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await resumeSpeech(tabId);
            return { state: await getSerializableState(tabId) };

        case "STOP_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await stopSpeech(tabId, { clearHighlights: true, resetOffset: true });
            return { state: await getSerializableState(tabId) };

        case "UPDATE_SETTINGS":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await updateSettings(tabId, message.settings || {});
            return { state: await getSerializableState(tabId) };

        case "FLOATING_TOGGLE_PLAYBACK":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await togglePlayback(tabId);
            return { state: await getSerializableState(tabId) };

        case "FLOATING_STOP_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await stopSpeech(tabId, { clearHighlights: true, resetOffset: true });
            return { state: await getSerializableState(tabId) };

        case "FLOATING_SEEK_READING":
            if (!tabId) {
                throw new Error("No active tab available.");
            }
            await seekSpeech(tabId, Number(message.offset) || 0, {
                autoplay: message.autoplay
            });
            return { state: await getSerializableState(tabId) };

        case "OFFSCREEN_PROGRESS":
            await handleOffscreenProgress(message);
            return {};

        case "OFFSCREEN_STATUS":
            await handleOffscreenStatus(message);
            return {};

        default:
            return {};
    }
}


async function handleCommand(command) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
        return;
    }

    try {
        if (command === "read-from-top") {
            await refreshDocumentText(tab.id);
            await startSpeech(tab.id, 0, { autoplay: true });
            return;
        }

        if (command === "toggle-playback") {
            await togglePlayback(tab.id);
        }
    } catch (error) {
        if (error.code !== "PAGE_NOT_SUPPORTED") {
            throw error;
        }

        // A shortcut on a page Cadence cannot read is not an error worth a red badge;
        // remember it so the popup can explain if the user opens it.
        console.warn(`Cadence: ${error.message}`);
        const state = await ensureTabState(tab.id);
        state.lastError = error.message;
        await persistTabState(tab.id, state);
    }
}


async function togglePlayback(tabId) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);

    if (state.sessionId && state.isSpeaking) {
        await pauseSpeech(tabId);
        return;
    }

    if (state.sessionId && state.isPaused) {
        await resumeSpeech(tabId);
        return;
    }

    await refreshDocumentText(tabId);
    await startSpeech(tabId, 0, { autoplay: true });
}


const CONTEXT_MENU_ACTIONS = {
    "cadence-read-from-here": "read-from-here",
    "cadence-continue-from-here": "continue-from-here",
    "cadence-read-selection": "read-selection",
    "cadence-send-to-paste": "send-to-paste"
};


async function handleContextMenuClick(info, tab) {
    if (!tab?.id) {
        return;
    }

    const action = CONTEXT_MENU_ACTIONS[info.menuItemId];
    if (!action) {
        return;
    }

    try {
        await ensureContentScriptReady(tab.id);
        await sendMessageToTab(tab.id, {
            type: "CONTEXT_MENU_ACTION",
            action,
            selectionText: info.selectionText || ""
        });
    } catch (error) {
        // page not injectable; nothing to surface
    }
}


async function updateContinueMenuVisibility(visible) {
    try {
        await chrome.contextMenus.update("cadence-continue-from-here", { visible });
    } catch (error) {
        // menu not created yet
    }
}


async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
}


async function ensureContentScriptReady(tabId) {
    const existing = await sendOptionalMessageToTab(tabId, { type: "CONTENT_PING" });
    if (existing && existing.ok) {
        return;
    }

    const tab = await chrome.tabs.get(tabId);
    if (!isInjectableTab(tab)) {
        throw pageNotSupportedError("Cadence cannot run on this page.");
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES
    });

    const injected = await sendOptionalMessageToTab(tabId, { type: "CONTENT_PING" });
    if (!injected || !injected.ok) {
        throw pageNotSupportedError("Cadence could not attach to this page.");
    }
}


function isInjectableTab(tab) {
    if (!tab || !tab.url) {
        return false;
    }

    return /^https?:\/\//.test(tab.url) || /^file:\/\//.test(tab.url);
}


// An expected condition (chrome://, new tab, Web Store, PDF viewer), not an extension failure.
function pageNotSupportedError(message) {
    const error = new Error(message);
    error.code = "PAGE_NOT_SUPPORTED";
    return error;
}


async function getSerializableState(tabId) {
    const state = await ensureTabState(tabId);
    await ensureActiveSpeechTabId();

    return {
        tabId,
        backendBaseUrl: state.settings.backendBaseUrl,
        currentOffset: state.currentOffset,
        hasDocumentText: Boolean(state.text),
        isSpeaking: state.isSpeaking,
        isPaused: state.isPaused,
        clickMode: state.settings.clickMode,
        dockAlwaysOn: state.settings.dockAlwaysOn !== false,
        pendingRestart: state.pendingRestart,
        voiceName: state.settings.voiceName,
        rate: state.settings.rate,
        lastError: state.lastError || "",
        isActiveTab: activeSpeechTabId === tabId,
        sourceKind: state.sourceKind || "page",
        textLength: (state.text || "").length
    };
}


async function ensureTabState(tabId) {
    if (tabStates.has(tabId)) {
        return tabStates.get(tabId);
    }

    const settings = await storageLocalGet(DEFAULT_SETTINGS);
    const stored = await loadPersistedTabState(tabId);
    const state = stored
        ? hydrateStoredState(stored, settings)
        : createInitialState(settings);

    tabStates.set(tabId, state);
    return state;
}


async function ensureActiveSpeechTabId() {
    if (activeSpeechTabId !== null) {
        return activeSpeechTabId;
    }

    const stored = await storageSessionGet({ [ACTIVE_TAB_STORAGE_KEY]: null });
    const nextTabId = stored[ACTIVE_TAB_STORAGE_KEY];
    activeSpeechTabId = typeof nextTabId === "number" ? nextTabId : null;
    return activeSpeechTabId;
}


async function cleanupRemovedTab(tabId) {
    const state = await ensureTabState(tabId).catch(() => null);

    if (state && state.sessionId) {
        void deleteBackendSession(state.sessionId, state.sessionBackendBaseUrl);
    }

    await ensureActiveSpeechTabId();
    if (activeSpeechTabId === tabId) {
        activeSpeechTabId = null;
        await persistActiveSpeechTabId();
        await sendOptionalOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_STOP",
            tabId,
            sessionToken: state ? state.sessionToken + 1 : 0
        });
    }

    tabStates.delete(tabId);
    await clearPersistedTabState(tabId);
}


async function updateSettings(tabId, incomingSettings) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    const currentSettings = await storageLocalGet(DEFAULT_SETTINGS);
    const nextSettings = {
        ...currentSettings,
        ...sanitizeSettings(incomingSettings)
    };

    await storageLocalSet(nextSettings);
    state.settings = nextSettings;
    for (const cached of tabStates.values()) {
        cached.settings = nextSettings;
    }

    const changedAlwaysOn = Object.prototype.hasOwnProperty.call(incomingSettings, "dockAlwaysOn");
    if (changedAlwaysOn) {
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs
            .filter((tab) => typeof tab.id === "number")
            .map((tab) => sendOptionalMessageToTab(tab.id, { type: "SET_DOCK_ALWAYS_ON", enabled: nextSettings.dockAlwaysOn })));
    }

    await persistTabState(tabId, state);

    const changedClickMode = Object.prototype.hasOwnProperty.call(incomingSettings, "clickMode");
    if (changedClickMode) {
        await ensureContentScriptReady(tabId);
        await sendOptionalMessageToTab(tabId, {
            type: "SET_CLICK_MODE",
            enabled: nextSettings.clickMode
        });
    }

    const changedVoice = Object.prototype.hasOwnProperty.call(incomingSettings, "voiceName");
    const changedRate = Object.prototype.hasOwnProperty.call(incomingSettings, "rate");
    const changedBackendBaseUrl = Object.prototype.hasOwnProperty.call(incomingSettings, "backendBaseUrl");

    if (state.sessionId && state.text && (changedVoice || changedRate || changedBackendBaseUrl)) {
        if (changedRate && state.isSpeaking) {
            await sendOptionalOffscreenMessage({
                target: "offscreen",
                type: "OFFSCREEN_SET_PLAYBACK_RATE",
                tabId,
                sessionToken: state.sessionToken,
                playbackRate: rateToPlaybackRate(nextSettings.rate)
            });
        }

        await startSpeech(tabId, state.currentOffset, { autoplay: state.isSpeaking });
        return;
    }

    await broadcastState(tabId);
}


async function refreshDocumentText(tabId) {
    await ensureContentScriptReady(tabId);
    const response = await sendMessageToTab(tabId, { type: "GET_READING_SNAPSHOT" });
    if (!response || !response.text || !response.text.trim()) {
        throw new Error("This page does not expose readable text for the extension.");
    }

    await setDocumentText(tabId, response.text);
}


async function setDocumentText(tabId, text, sourceKind = "page") {
    const state = await ensureTabState(tabId);
    state.text = text || "";
    state.currentOffset = clamp(state.currentOffset, 0, state.text.length);
    state.lastError = "";
    state.sourceKind = VALID_SOURCE_KINDS.has(sourceKind) ? sourceKind : "page";
    await persistTabState(tabId, state);
}


async function startSpeech(tabId, offset, options = {}) {
    const { autoplay = true } = options;
    const state = await ensureTabState(tabId);

    if (!state.text || !state.text.trim()) {
        await refreshDocumentText(tabId);
    }

    const text = state.text || "";
    const startOffset = clamp(Number(offset) || 0, 0, text.length);
    if (!text.slice(startOffset).trim()) {
        throw new Error("Nothing left to read from this location.");
    }

    await ensureActiveSpeechTabId();
    if (activeSpeechTabId !== null && activeSpeechTabId !== tabId) {
        await stopSpeech(activeSpeechTabId, { clearHighlights: true, resetOffset: false });
    }

    const previousSessionId = state.sessionId;
    const previousSessionBackendBaseUrl = state.sessionBackendBaseUrl;
    const sessionToken = state.sessionToken + 1;
    const session = await createPageReadSession({
        text,
        startOffset,
        voice: state.settings.voiceName,
        rate: state.settings.rate,
        backendBaseUrl: state.settings.backendBaseUrl
    });

    await ensureOffscreenDocument();

    state.sessionToken = sessionToken;
    state.sessionId = session.session_id;
    state.sessionStartOffset = session.start_offset;
    state.sessionBackendBaseUrl = state.settings.backendBaseUrl;
    state.currentOffset = session.start_offset;
    state.isSpeaking = false;
    state.isPaused = !autoplay;
    state.pendingRestart = false;
    state.lastError = "";
    activeSpeechTabId = tabId;

    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();

    try {
        await sendOptionalMessageToTab(tabId, {
            type: "READER_STARTED",
            startOffset: session.start_offset
        });

        await sendOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_START_SESSION",
            tabId,
            sessionId: session.session_id,
            sessionToken,
            startOffset: session.start_offset,
            audioUrl: absoluteBackendUrl(session.audio_url, state.settings.backendBaseUrl),
            eventsUrl: absoluteBackendUrl(session.events_url, state.settings.backendBaseUrl),
            autoplay,
            playbackRate: 1
        });
    } catch (error) {
        state.sessionId = null;
        state.sessionBackendBaseUrl = null;
        state.isSpeaking = false;
        state.isPaused = false;
        state.lastError = error.message || "Audio playback could not start.";
        if (activeSpeechTabId === tabId) {
            activeSpeechTabId = null;
        }
        await persistTabState(tabId, state);
        await persistActiveSpeechTabId();
        void deleteBackendSession(session.session_id, state.settings.backendBaseUrl);
        await broadcastState(tabId);
        throw error;
    }

    if (previousSessionId && previousSessionId !== session.session_id) {
        void deleteBackendSession(previousSessionId, previousSessionBackendBaseUrl);
    }

    await broadcastState(tabId);
}


async function pauseSpeech(tabId) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    if (!state.sessionId) {
        return;
    }

    await sendOffscreenMessage({
        target: "offscreen",
        type: "OFFSCREEN_PAUSE",
        tabId,
        sessionToken: state.sessionToken
    });

    state.isSpeaking = false;
    state.isPaused = true;
    await persistTabState(tabId, state);
    await broadcastState(tabId);
}


async function resumeSpeech(tabId) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    if (!state.text) {
        await refreshDocumentText(tabId);
    }

    if (!state.sessionId) {
        await startSpeech(tabId, state.currentOffset, { autoplay: true });
        return;
    }

    try {
        await ensureOffscreenDocument();
        await sendOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_RESUME",
            tabId,
            sessionToken: state.sessionToken
        });
    } catch (error) {
        await startSpeech(tabId, state.currentOffset, { autoplay: true });
        return;
    }

    state.isPaused = false;
    state.isSpeaking = true;
    activeSpeechTabId = tabId;
    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();
    await broadcastState(tabId);
}


async function stopSpeech(tabId, options = {}) {
    await syncTabStateWithOffscreen(tabId);
    const { clearHighlights = true, resetOffset = false } = options;
    const state = await ensureTabState(tabId);
    const sessionId = state.sessionId;
    const sessionBackendBaseUrl = state.sessionBackendBaseUrl;

    state.sessionToken += 1;

    if (sessionId || activeSpeechTabId === tabId) {
        await sendOptionalOffscreenMessage({
            target: "offscreen",
            type: "OFFSCREEN_STOP",
            tabId,
            sessionToken: state.sessionToken
        });
    }

    if (sessionId) {
        void deleteBackendSession(sessionId, sessionBackendBaseUrl);
    }

    if (activeSpeechTabId === tabId) {
        activeSpeechTabId = null;
    }

    state.sessionId = null;
    state.sessionStartOffset = 0;
    state.sessionBackendBaseUrl = null;
    state.isSpeaking = false;
    state.isPaused = false;
    state.pendingRestart = false;
    state.lastError = "";
    if (resetOffset) {
        state.currentOffset = 0;
    }

    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();

    if (clearHighlights) {
        await sendOptionalMessageToTab(tabId, { type: "CLEAR_READER" });
    }

    await broadcastState(tabId);
}


async function seekSpeech(tabId, offset, options = {}) {
    await syncTabStateWithOffscreen(tabId);
    const state = await ensureTabState(tabId);
    if (!state.text) {
        await refreshDocumentText(tabId);
    }

    const autoplay = typeof options.autoplay === "boolean"
        ? options.autoplay
        : state.isSpeaking;

    await startSpeech(tabId, offset, { autoplay });
}


async function handleOffscreenProgress(message) {
    const tabId = message.tabId;
    if (!tabId) {
        return;
    }

    const state = await ensureTabState(tabId);
    if (message.sessionToken !== state.sessionToken) {
        return;
    }

    state.currentOffset = normalizeResumeOffset(state.text, message.resumeOffset);
    await persistTabState(tabId, state);

    await sendOptionalMessageToTab(tabId, {
        type: "READING_PROGRESS",
        absoluteOffset: clamp(Number(message.highlightOffset) || 0, 0, state.text.length),
        resumeOffset: state.currentOffset
    });
}


async function handleOffscreenStatus(message) {
    const tabId = message.tabId;
    if (!tabId) {
        return;
    }

    const state = await ensureTabState(tabId);
    if (message.sessionToken !== state.sessionToken) {
        return;
    }

    switch (message.status) {
        case "play":
            state.isSpeaking = true;
            state.isPaused = false;
            state.lastError = "";
            activeSpeechTabId = tabId;
            break;

        case "pause":
            state.isSpeaking = false;
            state.isPaused = true;
            break;

        case "ready":
            state.isSpeaking = false;
            state.isPaused = true;
            state.lastError = "";
            activeSpeechTabId = tabId;
            break;

        case "ended":
            if (state.sessionId) {
                void deleteBackendSession(state.sessionId, state.sessionBackendBaseUrl);
            }
            state.currentOffset = state.text.length;
            state.isSpeaking = false;
            state.isPaused = false;
            state.pendingRestart = false;
            state.sessionId = null;
            state.sessionStartOffset = 0;
            state.sessionBackendBaseUrl = null;
            if (activeSpeechTabId === tabId) {
                activeSpeechTabId = null;
            }
            await sendOptionalMessageToTab(tabId, { type: "READING_DONE" });
            break;

        case "error":
            if (state.sessionId) {
                void deleteBackendSession(state.sessionId, state.sessionBackendBaseUrl);
            }
            state.isSpeaking = false;
            state.isPaused = false;
            state.pendingRestart = false;
            state.lastError = message.error || "Edge TTS playback failed.";
            state.sessionId = null;
            state.sessionStartOffset = 0;
            state.sessionBackendBaseUrl = null;
            if (activeSpeechTabId === tabId) {
                activeSpeechTabId = null;
            }
            await sendOptionalMessageToTab(tabId, { type: "CLEAR_READER" });
            break;

        default:
            return;
    }

    await persistTabState(tabId, state);
    await persistActiveSpeechTabId();
    await broadcastState(tabId);
}


async function syncTabStateWithOffscreen(tabId) {
    await ensureActiveSpeechTabId();

    const offscreenState = await getOffscreenState();
    if (!offscreenState || !offscreenState.hasAudio) {
        if (activeSpeechTabId !== null) {
            activeSpeechTabId = null;
            await persistActiveSpeechTabId();
        }
        return false;
    }

    activeSpeechTabId = offscreenState.tabId;
    await persistActiveSpeechTabId();

    if (offscreenState.tabId !== tabId) {
        return false;
    }

    const state = await ensureTabState(tabId);
    state.sessionId = offscreenState.sessionId || state.sessionId;
    state.sessionToken = offscreenState.sessionToken;
    state.sessionStartOffset = offscreenState.startOffset;
    state.currentOffset = normalizeResumeOffset(state.text, offscreenState.currentOffset);
    state.isSpeaking = Boolean(offscreenState.isPlaying);
    state.isPaused = Boolean(offscreenState.isPaused);
    await persistTabState(tabId, state);
    return true;
}


async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        return;
    }

    if (offscreenCreation) {
        await offscreenCreation;
        return;
    }

    offscreenCreation = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play streamed Edge TTS audio for webpage reading."
    });

    try {
        await offscreenCreation;
    } finally {
        offscreenCreation = null;
    }
}


async function hasOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

    if ("getContexts" in chrome.runtime) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [offscreenUrl]
        });
        return contexts.length > 0;
    }

    return false;
}


async function getOffscreenState() {
    if (!(await hasOffscreenDocument())) {
        return null;
    }

    const response = await sendOptionalOffscreenMessage({
        target: "offscreen",
        type: "OFFSCREEN_GET_STATE"
    });

    if (!response || !response.state) {
        return null;
    }

    return response.state;
}


async function fetchBackendVoices() {
    const settings = await storageLocalGet(DEFAULT_SETTINGS);
    const backendBaseUrl = settings.backendBaseUrl;

    const cached = await storageLocalGet({ voiceCache: null });
    const voiceCache = cached.voiceCache;
    if (
        voiceCache &&
        voiceCache.backendBaseUrl === backendBaseUrl &&
        Date.now() - voiceCache.fetchedAt < VOICE_CACHE_TTL_MS
    ) {
        return voiceCache.voices;
    }

    const voices = await fetchBackendJson("/api/voices", {}, backendBaseUrl);
    await storageLocalSet({
        voiceCache: { backendBaseUrl, fetchedAt: Date.now(), voices }
    });
    return voices;
}


async function createPageReadSession(payload) {
    return fetchBackendJson("/api/page-read-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            text: payload.text,
            start_offset: payload.startOffset,
            voice: payload.voice,
            rate: payload.rate
        })
    }, payload.backendBaseUrl);
}


async function deleteBackendSession(sessionId, backendBaseUrl) {
    if (!sessionId) {
        return;
    }

    try {
        await fetch(absoluteBackendUrl(`/api/read-sessions/${sessionId}`, backendBaseUrl), {
            method: "DELETE"
        });
    } catch (error) {
        // Ignore cleanup errors.
    }
}


async function fetchBackendJson(path, options = {}, backendBaseUrl) {
    const response = await fetch(absoluteBackendUrl(path, backendBaseUrl), options);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(payload.error || `Backend request failed with ${response.status}`);
    }

    return payload;
}


function absoluteBackendUrl(path, backendBaseUrl) {
    if (/^https?:\/\//.test(path)) {
        return path;
    }
    return `${normalizeBackendBaseUrl(backendBaseUrl || DEFAULT_BACKEND_BASE_URL)}${path}`;
}


async function broadcastState(tabId) {
    const state = await getSerializableState(tabId);
    void updateContinueMenuVisibility(Boolean(state.isSpeaking || state.isPaused));

    const payload = {
        type: "STATE_UPDATED",
        state
    };

    try {
        await chrome.runtime.sendMessage(payload);
    } catch (error) {
        // Ignore when no popup is listening.
    }

    await sendOptionalMessageToTab(tabId, {
        type: "READER_STATE_UPDATED",
        state
    });
}


async function sendMessageToTab(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        const fallback = chrome.runtime.lastError?.message;
        if (fallback) {
            throw new Error(fallback);
        }
        throw error;
    }
}


async function sendOptionalMessageToTab(tabId, message) {
    try {
        return await sendMessageToTab(tabId, message);
    } catch (error) {
        return null;
    }
}


async function sendOffscreenMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.ok === false) {
        throw new Error(response?.error || "Offscreen audio controller did not respond.");
    }
    return response;
}


async function sendOptionalOffscreenMessage(message) {
    try {
        return await sendOffscreenMessage(message);
    } catch (error) {
        return null;
    }
}


function createInitialState(settings) {
    return {
        settings,
        text: "",
        currentOffset: 0,
        sessionId: null,
        sessionToken: 0,
        sessionStartOffset: 0,
        sessionBackendBaseUrl: null,
        isSpeaking: false,
        isPaused: false,
        pendingRestart: false,
        lastError: "",
        sourceKind: "page"
    };
}


function hydrateStoredState(storedState, settings) {
    return {
        settings,
        text: typeof storedState.text === "string" ? storedState.text : "",
        currentOffset: Number.isFinite(storedState.currentOffset) ? storedState.currentOffset : 0,
        sessionId: typeof storedState.sessionId === "string" ? storedState.sessionId : null,
        sessionToken: Number.isFinite(storedState.sessionToken) ? storedState.sessionToken : 0,
        sessionStartOffset: Number.isFinite(storedState.sessionStartOffset) ? storedState.sessionStartOffset : 0,
        sessionBackendBaseUrl: typeof storedState.sessionBackendBaseUrl === "string"
            ? normalizeBackendBaseUrl(storedState.sessionBackendBaseUrl)
            : null,
        isSpeaking: Boolean(storedState.isSpeaking),
        isPaused: Boolean(storedState.isPaused),
        pendingRestart: Boolean(storedState.pendingRestart),
        lastError: typeof storedState.lastError === "string" ? storedState.lastError : "",
        sourceKind: VALID_SOURCE_KINDS.has(storedState.sourceKind) ? storedState.sourceKind : "page"
    };
}


function serializeTabState(state) {
    return {
        settings: state.settings,
        text: state.text,
        currentOffset: state.currentOffset,
        sessionId: state.sessionId,
        sessionToken: state.sessionToken,
        sessionStartOffset: state.sessionStartOffset,
        sessionBackendBaseUrl: state.sessionBackendBaseUrl,
        isSpeaking: state.isSpeaking,
        isPaused: state.isPaused,
        pendingRestart: state.pendingRestart,
        lastError: state.lastError,
        sourceKind: state.sourceKind
    };
}


async function loadPersistedTabState(tabId) {
    const key = tabStateStorageKey(tabId);
    const stored = await storageSessionGet({ [key]: null });
    return stored[key] || null;
}


async function persistTabState(tabId, state) {
    await storageSessionSet({
        [tabStateStorageKey(tabId)]: serializeTabState(state)
    });
}


async function clearPersistedTabState(tabId) {
    await storageSessionRemove(tabStateStorageKey(tabId));
}


async function persistActiveSpeechTabId() {
    if (activeSpeechTabId === null) {
        await storageSessionRemove(ACTIVE_TAB_STORAGE_KEY);
        return;
    }

    await storageSessionSet({ [ACTIVE_TAB_STORAGE_KEY]: activeSpeechTabId });
}


function tabStateStorageKey(tabId) {
    return `${TAB_STATE_STORAGE_PREFIX}${tabId}`;
}


function sanitizeSettings(settings) {
    const next = {};

    if (Object.prototype.hasOwnProperty.call(settings, "backendBaseUrl")) {
        next.backendBaseUrl = sanitizeBackendBaseUrl(settings.backendBaseUrl);
    }

    if (Object.prototype.hasOwnProperty.call(settings, "voiceName")) {
        next.voiceName = typeof settings.voiceName === "string"
            ? settings.voiceName
            : DEFAULT_SETTINGS.voiceName;
    }

    if (Object.prototype.hasOwnProperty.call(settings, "rate")) {
        const nextRate = typeof settings.rate === "string"
            ? settings.rate
            : DEFAULT_SETTINGS.rate;
        next.rate = VALID_RATES.has(nextRate) ? nextRate : DEFAULT_SETTINGS.rate;
    }

    if (Object.prototype.hasOwnProperty.call(settings, "clickMode")) {
        next.clickMode = Boolean(settings.clickMode);
    }

    if (Object.prototype.hasOwnProperty.call(settings, "dockAlwaysOn")) {
        next.dockAlwaysOn = Boolean(settings.dockAlwaysOn);
    }

    return next;
}


function sanitizeBackendBaseUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
        return DEFAULT_BACKEND_BASE_URL;
    }

    return normalizeBackendBaseUrl(value);
}


function normalizeBackendBaseUrl(value) {
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) {
            throw new Error("Unsupported protocol");
        }
        return url.toString().replace(/\/$/, "");
    } catch (error) {
        return DEFAULT_BACKEND_BASE_URL;
    }
}


function normalizeResumeOffset(text, offset) {
    const safeText = text || "";
    let cursor = clamp(Number(offset) || 0, 0, safeText.length);
    while (cursor < safeText.length && /\s/.test(safeText[cursor])) {
        cursor += 1;
    }
    return clamp(cursor, 0, safeText.length);
}


function rateToPlaybackRate(rate) {
    const match = /^([+-])(\d+)%$/.exec(rate || "+0%");
    if (!match) {
        return 1;
    }

    const direction = match[1] === "+" ? 1 : -1;
    const amount = Number(match[2]) / 100;
    return clamp(1 + direction * amount, 0.5, 2);
}


function storageLocalGet(defaults) {
    return new Promise((resolve) => {
        chrome.storage.local.get(defaults, (value) => {
            resolve(value);
        });
    });
}


function storageLocalSet(values) {
    return new Promise((resolve) => {
        chrome.storage.local.set(values, () => resolve());
    });
}


function storageSessionGet(defaults) {
    return new Promise((resolve) => {
        chrome.storage.session.get(defaults, (value) => {
            resolve(value);
        });
    });
}


function storageSessionSet(values) {
    return new Promise((resolve) => {
        chrome.storage.session.set(values, () => resolve());
    });
}


function storageSessionRemove(keys) {
    return new Promise((resolve) => {
        chrome.storage.session.remove(keys, () => resolve());
    });
}


function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
