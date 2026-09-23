(function () {
    const BLOCK_TAGS = new Set([
        "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
        "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
        "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL"
    ]);

    const SKIP_TAGS = new Set([
        "AUDIO", "BUTTON", "CANVAS", "DATALIST", "IFRAME", "IMG", "INPUT", "METER", "NOSCRIPT",
        "OPTION", "PROGRESS", "SCRIPT", "SELECT", "STYLE", "SVG", "TEXTAREA", "VIDEO"
    ]);

    const LAYOUT_SKIP_TAGS = new Set(["HEADER", "NAV", "FOOTER", "ASIDE"]);
    const RATE_STEPS = ["-25%", "+0%", "+25%", "+50%"];
    const RATE_LABELS = {
        "-25%": "0.75×",
        "+0%": "1.0×",
        "+25%": "1.25×",
        "+50%": "1.5×"
    };
    const OVERLAY_ID = "twelve-reader-overlay";
    const STYLE_ID = "twelve-reader-style";
    const TOAST_ID = "twelve-reader-toast";
    const CONTROLLER_ID = "twelve-reader-controller";
    const CONTROLLER_TITLE_ID = "twelve-reader-controller-title";
    const CONTROLLER_SUBTITLE_ID = "twelve-reader-controller-subtitle";
    const CONTROLLER_STATUS_ID = "twelve-reader-controller-status";
    const CONTROLLER_CURRENT_TIME_ID = "twelve-reader-controller-current-time";
    const CONTROLLER_TOTAL_TIME_ID = "twelve-reader-controller-total-time";
    const CONTROLLER_SEEK_ID = "twelve-reader-controller-seek";
    const CONTROLLER_SPEED_ID = "twelve-reader-controller-speed";
    const CONTROLLER_VOICE_ID = "twelve-reader-controller-voice";
    const CONTROLLER_CLOSE_ID = "twelve-reader-controller-close";
    const CONTROLLER_REWIND_ID = "twelve-reader-controller-rewind";
    const CONTROLLER_PREVIOUS_ID = "twelve-reader-controller-previous";
    const CONTROLLER_TOGGLE_ID = "twelve-reader-controller-toggle";
    const CONTROLLER_NEXT_ID = "twelve-reader-controller-next";
    const CONTROLLER_FORWARD_ID = "twelve-reader-controller-forward";
    const CONTROLLER_COLLAPSE_ID = "twelve-reader-controller-collapse";
    const CONTROLLER_EXPAND_ID = "twelve-reader-controller-expand";
    const CONTROLLER_PILL_TOGGLE_ID = "twelve-reader-controller-pill-toggle";
    const CONTROLLER_PILL_LABEL_ID = "twelve-reader-controller-pill-label";
    const CONTROLLER_PILL_RING_ID = "twelve-reader-controller-pill-ring";
    const CONTROLLER_PASTE_OPEN_ID = "twelve-reader-controller-paste-open";
    const CONTROLLER_PASTE_CLOSE_ID = "twelve-reader-controller-paste-close";
    const CONTROLLER_PASTE_INPUT_ID = "twelve-reader-controller-paste-input";
    const CONTROLLER_PASTE_READ_ID = "twelve-reader-controller-paste-read";
    const CONTROLLER_PASTE_CLEAR_ID = "twelve-reader-controller-paste-clear";

    const state = {
        clickMode: false,
        readingMap: null,
        dirty: true,
        activeSentenceRange: null,
        activeWordRange: null,
        readerState: null,
        availableVoices: [],
        voicesPromise: null,
        voiceLoadErrorShown: false,
        mutationObserver: null,
        resizeScheduled: false,
        isScrubbing: false,
        scrubRatio: 0,
        // Dock (§2): in-memory only, resets on navigation/reload — no persistence per contract §7.
        dockCollapsed: false,
        dockEverShown: false,
        dockDismissed: false,
        dockPasteOpen: false,
        externalText: null,
        externalModel: null,
        lastContextPoint: null
    };

    injectStyles();
    installMutationObserver();
    bindEvents();
    syncInitialState();

    async function syncInitialState() {
        try {
            const response = await chrome.runtime.sendMessage({ type: "CONTENT_READY" });
            if (response && response.ok && response.state) {
                state.clickMode = Boolean(response.state.clickMode);
                updateClickModeMarker();
                applyReaderState(response.state);
            }
        } catch (error) {
            // Ignore when the background worker is temporarily unavailable.
        }
    }

    function bindEvents() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            handleMessage(message)
                .then((result) => sendResponse(result || { ok: true }))
                .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
            return true;
        });

        document.addEventListener("click", onDocumentClick, true);
        document.addEventListener("keydown", onDocumentKeyDown, true);
        document.addEventListener("contextmenu", (event) => {
            state.lastContextPoint = { x: event.clientX, y: event.clientY, target: event.target };
        }, true);
        window.addEventListener("scroll", scheduleHighlightRedraw, { passive: true });
        window.addEventListener("resize", scheduleHighlightRedraw, { passive: true });
    }

    async function onDocumentKeyDown(event) {
        if (!isPlaybackShortcut(event)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        try {
            const response = await chrome.runtime.sendMessage({ type: "FLOATING_TOGGLE_PLAYBACK" });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Playback control failed.");
            }
            if (response.state) {
                applyReaderState(response.state);
            }
        } catch (error) {
            showToast(error.message || "Playback control failed.");
        }
    }

    function isPlaybackShortcut(event) {
        if (!event || event.defaultPrevented || event.repeat) {
            return false;
        }

        if (event.altKey || event.shiftKey) {
            return false;
        }

        if (!(event.ctrlKey || event.metaKey)) {
            return false;
        }

        if ((event.key || "").toLowerCase() !== "u") {
            return false;
        }

        return !isEditableTarget(event.target);
    }

    function isEditableTarget(target) {
        const element = target instanceof Element ? target : target?.parentElement;
        if (!element) {
            return false;
        }

        if (element.closest("input, textarea, select, [contenteditable]")) {
            return true;
        }

        return element instanceof HTMLElement && element.isContentEditable;
    }

    async function handleMessage(message) {
        switch (message.type) {
            case "GET_READING_SNAPSHOT": {
                const readingMap = buildOrReuseReadingMap();
                return {
                    ok: true,
                    text: readingMap.text,
                    url: location.href,
                    title: document.title
                };
            }

            case "CONTENT_PING":
                return { ok: true };

            case "SET_CLICK_MODE":
                state.clickMode = Boolean(message.enabled);
                updateClickModeMarker();
                showToast(state.clickMode ? "Cadence click-to-read enabled" : "Cadence click-to-read disabled");
                return { ok: true };

            case "READER_STATE_UPDATED":
                applyReaderState(message.state || null);
                return { ok: true };

            case "READER_STARTED": {
                const isPageSource = !state.readerState?.sourceKind || state.readerState.sourceKind === "page";
                if (isPageSource) {
                    buildOrReuseReadingMap();
                } else {
                    clearHighlights();
                }
                if (state.readerState) {
                    state.readerState.currentOffset = Number(message.startOffset) || 0;
                    syncFloatingControllerProgress(state.readerState);
                }
                return { ok: true };
            }

            case "READING_PROGRESS": {
                const isPageSource = !state.readerState?.sourceKind || state.readerState.sourceKind === "page";
                if (isPageSource) {
                    buildOrReuseReadingMap();
                    if (!highlightOffset(message.absoluteOffset || 0)) {
                        state.dirty = true;
                        buildOrReuseReadingMap();
                        highlightOffset(message.absoluteOffset || 0);
                    }
                }
                if (state.readerState) {
                    state.readerState.currentOffset = message.resumeOffset || message.absoluteOffset || 0;
                    syncFloatingControllerProgress(state.readerState);
                }
                return { ok: true };
            }

            case "READING_DONE":
                scheduleHighlightRedraw();
                showToast("Cadence finished this page");
                return { ok: true };

            case "CLEAR_READER":
                clearHighlights();
                hideFloatingController();
                return { ok: true };

            case "CONTEXT_MENU_ACTION":
                await handleContextMenuAction(message);
                return { ok: true };

            default:
                return { ok: true };
        }
    }

    async function onDocumentClick(event) {
        const targetElement = event.target instanceof Element ? event.target : event.target?.parentElement;

        if (!state.clickMode) {
            return;
        }

        if (event.defaultPrevented) {
            return;
        }

        if (!targetElement) {
            return;
        }

        if (targetElement.closest(`#${OVERLAY_ID}`) || targetElement.closest(`#${CONTROLLER_ID}`)) {
            return;
        }

        if (targetElement.closest("input, textarea, select, button")) {
            return;
        }

        const readingMap = buildOrReuseReadingMap();
        if (!readingMap.text.trim()) {
            return;
        }

        const offset = getOffsetFromPoint(event.clientX, event.clientY, targetElement, readingMap);
        if (offset == null) {
            return;
        }

        if (targetElement.closest("a")) {
            event.preventDefault();
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        try {
            const response = await chrome.runtime.sendMessage({
                type: "PAGE_CLICK_READING_REQUEST",
                offset,
                text: readingMap.text
            });

            if (!response || !response.ok) {
                throw new Error(response?.error || "Could not start webpage reading.");
            }
        } catch (error) {
            showToast(error.message || "Cadence could not start reading here.");
        }
    }

    // Reuses the onDocumentClick PAGE_CLICK_READING_REQUEST pattern, but sourced from the
    // last right-click point (§4) instead of a click event, and applies the returned state directly.
    async function readFromContextPoint() {
        const point = state.lastContextPoint;
        const readingMap = buildOrReuseReadingMap();
        const offset = point?.target ? getOffsetFromPoint(point.x, point.y, point.target, readingMap) : null;
        if (offset == null) {
            showToast("Right-click on some text first.");
            return;
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: "PAGE_CLICK_READING_REQUEST",
                offset,
                text: readingMap.text
            });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Could not start webpage reading.");
            }
            if (response.state) {
                applyReaderState(response.state);
            }
        } catch (error) {
            showToast(error.message || "Cadence could not start reading here.");
        }
    }

    async function handleContextMenuAction(message) {
        const action = message.action;

        if (action === "read-from-here") {
            await readFromContextPoint();
            return;
        }

        if (action === "continue-from-here") {
            const readerState = state.readerState;
            const isPageSession = Boolean(
                readerState
                && (readerState.isSpeaking || readerState.isPaused)
                && (!readerState.sourceKind || readerState.sourceKind === "page")
            );
            if (!isPageSession) {
                await readFromContextPoint();
                return;
            }

            const point = state.lastContextPoint;
            const readingMap = buildOrReuseReadingMap();
            const offset = point?.target ? getOffsetFromPoint(point.x, point.y, point.target, readingMap) : null;
            if (offset == null) {
                showToast("Right-click on some text first.");
                return;
            }
            await requestFloatingSeek(offset, { autoplay: true });
            return;
        }

        if (action === "read-selection") {
            const text = (window.getSelection()?.toString() || message.selectionText || "").trim();
            if (!text) {
                showToast("Select some text first.");
                return;
            }
            await sendReadTextAction(text, "selection");
            return;
        }

        if (action === "send-to-paste") {
            const text = (window.getSelection()?.toString() || message.selectionText || "").trim();
            if (!text) {
                showToast("Select some text first.");
                return;
            }
            openPastePanel(text);
        }
    }

    function buildOrReuseReadingMap() {
        if (!state.dirty && state.readingMap) {
            return state.readingMap;
        }

        const textNodes = collectReadableTextNodes();
        const runs = [];
        const runLookup = new WeakMap();
        const blockCache = new WeakMap();
        let text = "";
        let previousNode = null;

        textNodes.forEach((node) => {
            const nodeText = node.nodeValue || "";
            if (!nodeText.trim()) {
                return;
            }

            const separator = determineSeparator(previousNode, node, blockCache);
            text += separator;

            const start = text.length;
            text += nodeText;
            const end = text.length;

            const run = {
                node,
                start,
                end,
                text: nodeText,
                element: node.parentElement
            };
            runs.push(run);
            runLookup.set(node, run);
            previousNode = node;
        });

        state.readingMap = {
            text,
            runs,
            runLookup,
            wordCount: countWords(text),
            sentenceRanges: buildSentenceRanges(text)
        };
        state.dirty = false;
        return state.readingMap;
    }

    function collectReadableTextNodes() {
        const body = document.body;
        if (!body) {
            return [];
        }

        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.parentElement) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (!node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (isInsideOverlay(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (isInsideSkippedElement(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (!isElementVisible(node.parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const nodes = [];
        while (walker.nextNode()) {
            nodes.push(walker.currentNode);
        }
        return nodes;
    }

    function isInsideOverlay(element) {
        return Boolean(element.closest(`#${OVERLAY_ID}`));
    }

    function isInsideSkippedElement(element) {
        let current = element;
        while (current && current !== document.body) {
            if (SKIP_TAGS.has(current.tagName)) {
                return true;
            }

            if (current.getAttribute("aria-hidden") === "true") {
                return true;
            }

            if (current.isContentEditable) {
                return true;
            }

            if (LAYOUT_SKIP_TAGS.has(current.tagName) && !current.closest("main, article")) {
                return true;
            }

            current = current.parentElement;
        }

        return false;
    }

    function isElementVisible(element) {
        let current = element;
        while (current && current !== document.body) {
            const styles = window.getComputedStyle(current);
            if (styles.display === "none" || styles.visibility === "hidden") {
                return false;
            }
            current = current.parentElement;
        }
        return true;
    }

    function determineSeparator(previousNode, currentNode, blockCache) {
        if (!previousNode) {
            return "";
        }

        const previousBlock = findLogicalBlock(previousNode.parentElement, blockCache);
        const currentBlock = findLogicalBlock(currentNode.parentElement, blockCache);
        const between = getTextBetween(previousNode, currentNode);

        if (previousBlock !== currentBlock) {
            if (/\n{2,}/.test(between)) {
                return "\n\n";
            }
            if (/\n/.test(between)) {
                return "\n";
            }
            return "\n\n";
        }

        if (/\n{2,}/.test(between)) {
            return "\n\n";
        }
        if (/\n/.test(between)) {
            return "\n";
        }
        if (/\s/.test(between)) {
            return " ";
        }

        return "";
    }

    function findLogicalBlock(element, cache) {
        if (!element) {
            return document.body;
        }

        if (cache.has(element)) {
            return cache.get(element);
        }

        let current = element;
        while (current && current !== document.body) {
            if (BLOCK_TAGS.has(current.tagName)) {
                cache.set(element, current);
                return current;
            }

            const display = window.getComputedStyle(current).display;
            if (display === "block" || display === "list-item" || display === "table-cell" || display === "table-row") {
                cache.set(element, current);
                return current;
            }

            current = current.parentElement;
        }

        cache.set(element, document.body);
        return document.body;
    }

    function getTextBetween(previousNode, currentNode) {
        try {
            const range = document.createRange();
            range.setStartAfter(previousNode);
            range.setEndBefore(currentNode);
            return range.toString();
        } catch (error) {
            return "";
        }
    }

    function getOffsetFromPoint(clientX, clientY, target, readingMap) {
        if (document.caretPositionFromPoint) {
            const caret = document.caretPositionFromPoint(clientX, clientY);
            if (caret) {
                const offset = convertNodeOffsetToGlobal(caret.offsetNode, caret.offset, readingMap);
                if (offset != null) {
                    return offset;
                }
            }
        }

        if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(clientX, clientY);
            if (range) {
                const offset = convertNodeOffsetToGlobal(range.startContainer, range.startOffset, readingMap);
                if (offset != null) {
                    return offset;
                }
            }
        }

        return findOffsetFromTarget(target, readingMap);
    }

    function convertNodeOffsetToGlobal(node, localOffset, readingMap) {
        if (!node) {
            return null;
        }

        const directRun = readingMap.runLookup.get(node);
        if (directRun) {
            return clamp(directRun.start + localOffset, directRun.start, directRun.end);
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const childTextNode = resolveClosestTextNode(node, localOffset);
            if (!childTextNode) {
                return null;
            }
            const run = readingMap.runLookup.get(childTextNode);
            if (!run) {
                return null;
            }
            return clamp(run.start + localOffset, run.start, run.end);
        }

        return null;
    }

    function resolveClosestTextNode(node, localOffset) {
        if (node.nodeType === Node.TEXT_NODE) {
            return node;
        }

        const children = node.childNodes;
        if (!children.length) {
            return null;
        }

        const clampedIndex = clamp(localOffset, 0, children.length - 1);
        const directChild = children[clampedIndex] || children[clampedIndex - 1];
        if (!directChild) {
            return null;
        }

        if (directChild.nodeType === Node.TEXT_NODE) {
            return directChild;
        }

        const walker = document.createTreeWalker(directChild, NodeFilter.SHOW_TEXT);
        return walker.nextNode();
    }

    function findOffsetFromTarget(target, readingMap) {
        if (!(target instanceof Node)) {
            return null;
        }

        const run = readingMap.runs.find((candidate) => candidate.element && candidate.element.contains(target));
        return run ? run.start : null;
    }

    function buildSentenceRanges(text) {
        const ranges = [];

        if (window.Intl && Intl.Segmenter) {
            const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
            for (const segment of segmenter.segment(text)) {
                const trimmed = trimRange(text, segment.index, segment.index + segment.segment.length);
                if (trimmed) {
                    ranges.push(trimmed);
                }
            }
        }

        if (ranges.length) {
            return ranges;
        }

        const fallback = text.matchAll(/[^.!?\n]+(?:[.!?]+|\n+|$)/g);
        for (const match of fallback) {
            const start = match.index || 0;
            const end = start + match[0].length;
            const trimmed = trimRange(text, start, end);
            if (trimmed) {
                ranges.push(trimmed);
            }
        }

        if (!ranges.length && text.trim()) {
            return [{ start: 0, end: text.length }];
        }

        return ranges;
    }

    function trimRange(text, start, end) {
        let safeStart = start;
        let safeEnd = end;

        while (safeStart < safeEnd && /\s/.test(text[safeStart])) {
            safeStart += 1;
        }
        while (safeEnd > safeStart && /\s/.test(text[safeEnd - 1])) {
            safeEnd -= 1;
        }

        if (safeEnd <= safeStart) {
            return null;
        }

        return { start: safeStart, end: safeEnd };
    }

    function findSentenceForOffset(offset, sentenceRanges) {
        for (let index = 0; index < sentenceRanges.length; index += 1) {
            const range = sentenceRanges[index];
            if (offset >= range.start && offset < range.end) {
                return range;
            }
        }

        if (sentenceRanges.length && offset >= sentenceRanges[sentenceRanges.length - 1].end) {
            return sentenceRanges[sentenceRanges.length - 1];
        }

        return sentenceRanges[0] || null;
    }

    function findWordRangeAtOffset(text, offset) {
        const safeLength = text.length;
        if (!safeLength) {
            return null;
        }

        let cursor = clamp(offset, 0, safeLength - 1);
        while (cursor < safeLength && /\s/.test(text[cursor])) {
            cursor += 1;
        }
        if (cursor >= safeLength) {
            cursor = safeLength - 1;
        }

        let start = cursor;
        while (start > 0 && isWordCharacter(text[start - 1])) {
            start -= 1;
        }

        let end = cursor;
        while (end < safeLength && isWordCharacter(text[end])) {
            end += 1;
        }

        if (start === end) {
            start = cursor;
            while (start > 0 && !/\s/.test(text[start - 1]) && !isBoundaryPunctuation(text[start - 1])) {
                start -= 1;
            }
            end = cursor;
            while (end < safeLength && !/\s/.test(text[end]) && !isBoundaryPunctuation(text[end])) {
                end += 1;
            }
        }

        if (end <= start) {
            return null;
        }

        return { start, end };
    }

    function isWordCharacter(character) {
        return /[\p{L}\p{N}'-]/u.test(character);
    }

    function isBoundaryPunctuation(character) {
        return /[.,;:!?()[\]{}]/.test(character);
    }

    function highlightOffset(offset) {
        const readingMap = buildOrReuseReadingMap();
        const wordRange = findWordRangeAtOffset(readingMap.text, offset);
        const sentenceRange = findSentenceForOffset(offset, readingMap.sentenceRanges);

        state.activeWordRange = wordRange;
        state.activeSentenceRange = sentenceRange;
        const drewHighlights = redrawHighlights();
        scrollSentenceIntoView(sentenceRange, readingMap);
        return drewHighlights;
    }

    function redrawHighlights() {
        clearOverlayBlocks();

        if (!state.activeSentenceRange && !state.activeWordRange) {
            return false;
        }

        positionOverlay();
        const readingMap = buildOrReuseReadingMap();
        let drawnBlocks = 0;

        if (state.activeSentenceRange) {
            drawnBlocks += drawRangeRects(readingMap, state.activeSentenceRange, "twelve-reader-highlight sentence");
        }
        if (state.activeWordRange) {
            drawnBlocks += drawRangeRects(readingMap, state.activeWordRange, "twelve-reader-highlight word");
        }

        return drawnBlocks > 0;
    }

    function drawRangeRects(readingMap, rangeLike, className) {
        const range = createDomRange(readingMap.runs, rangeLike.start, rangeLike.end);
        if (!range) {
            return 0;
        }

        const overlay = ensureOverlay();
        const fragment = document.createDocumentFragment();
        let drawnBlocks = 0;
        Array.from(range.getClientRects()).forEach((rect) => {
            if (rect.width < 1 || rect.height < 1) {
                return;
            }

            const block = document.createElement("div");
            block.className = className;
            block.style.left = `${rect.left + window.scrollX}px`;
            block.style.top = `${rect.top + window.scrollY}px`;
            block.style.width = `${rect.width}px`;
            block.style.height = `${rect.height}px`;
            fragment.appendChild(block);
            drawnBlocks += 1;
        });

        overlay.appendChild(fragment);
        return drawnBlocks;
    }

    function createDomRange(runs, start, end) {
        if (!runs.length) {
            return null;
        }

        const maxOffset = runs[runs.length - 1].end;
        const safeStart = clamp(start, 0, maxOffset);
        const safeEnd = clamp(end, safeStart, maxOffset);
        if (safeEnd <= safeStart) {
            return null;
        }

        const startPosition = resolveOffsetPosition(runs, safeStart, "forward");
        const endPosition = resolveOffsetPosition(runs, safeEnd, "backward");
        if (!startPosition || !endPosition) {
            return null;
        }

        try {
            const range = document.createRange();
            range.setStart(startPosition.node, startPosition.offset);
            range.setEnd(endPosition.node, endPosition.offset);
            return range.collapsed ? null : range;
        } catch (error) {
            return null;
        }
    }

    function resolveOffsetPosition(runs, offset, bias) {
        let low = 0;
        let high = runs.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const run = runs[mid];
            if (offset < run.start) {
                high = mid - 1;
            } else if (offset >= run.end) {
                low = mid + 1;
            } else {
                return {
                    node: run.node,
                    offset: offset - run.start
                };
            }
        }

        if (bias === "forward") {
            const run = runs[Math.min(low, runs.length - 1)];
            return { node: run.node, offset: 0 };
        }

        const run = runs[Math.max(high, 0)];
        return { node: run.node, offset: run.text.length };
    }

    function clearHighlights() {
        state.activeSentenceRange = null;
        state.activeWordRange = null;
        clearOverlayBlocks();
    }

    function clearOverlayBlocks() {
        const overlay = ensureOverlay();
        overlay.innerHTML = "";
    }

    function ensureOverlay() {
        let overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = OVERLAY_ID;
            overlay.setAttribute("aria-hidden", "true");
            document.documentElement.appendChild(overlay);
        }
        positionOverlay();
        return overlay;
    }

    function positionOverlay() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            return;
        }

        overlay.style.width = `${Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)}px`;
        overlay.style.height = `${Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)}px`;
    }

    function scrollSentenceIntoView(sentenceRange, readingMap) {
        if (!sentenceRange) {
            return;
        }

        const range = createDomRange(readingMap.runs, sentenceRange.start, sentenceRange.end);
        if (!range) {
            return;
        }

        const rect = range.getBoundingClientRect();
        const viewportPadding = 120;
        if (rect.top < viewportPadding || rect.bottom > window.innerHeight - viewportPadding) {
            const top = rect.top + window.scrollY - viewportPadding;
            window.scrollTo({ top, behavior: "smooth" });
        }
    }

    function scheduleHighlightRedraw() {
        if (state.resizeScheduled) {
            return;
        }

        state.resizeScheduled = true;
        window.requestAnimationFrame(() => {
            state.resizeScheduled = false;
            if (state.activeSentenceRange || state.activeWordRange) {
                redrawHighlights();
            }
        });
    }

    function installMutationObserver() {
        if (!document.body) {
            return;
        }

        state.mutationObserver = new MutationObserver(() => {
            state.dirty = true;
        });

        state.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function updateClickModeMarker() {
        document.documentElement.toggleAttribute("data-twelve-reader-click-mode", state.clickMode);
    }

    function applyReaderState(readerState) {
        const previousBackendBaseUrl = state.readerState?.backendBaseUrl || "";
        const previousSourceKind = state.readerState?.sourceKind || "page";
        state.readerState = readerState || null;
        if (readerState && previousBackendBaseUrl !== (readerState.backendBaseUrl || "")) {
            state.availableVoices = [];
            state.voicesPromise = null;
            state.voiceLoadErrorShown = false;
        }
        const nextSourceKind = readerState?.sourceKind || "page";
        if (nextSourceKind !== "page" && nextSourceKind !== previousSourceKind) {
            // ponytail: guard against stale page highlights lingering under a paste/selection read
            clearHighlights();
        }
        updateFloatingController(readerState || null);
    }

    // ponytail: sentence index instead of paragraph index; sentence ranges already exist, paragraph mapping does not
    function getActiveTextModel() {
        const readerState = state.readerState;
        if (!readerState || !readerState.sourceKind || readerState.sourceKind === "page") {
            const readingMap = buildOrReuseReadingMap();
            return {
                isPage: true,
                text: readingMap.text,
                textLength: readingMap.text.length,
                wordCount: readingMap.wordCount,
                sentenceRanges: readingMap.sentenceRanges
            };
        }

        if (state.externalText) {
            if (!state.externalModel || state.externalModel.text !== state.externalText) {
                state.externalModel = {
                    text: state.externalText,
                    textLength: state.externalText.length,
                    wordCount: countWords(state.externalText),
                    sentenceRanges: buildSentenceRanges(state.externalText)
                };
            }
            return { isPage: false, ...state.externalModel };
        }

        // ponytail: rough word estimate when the pasted text is not available locally (content script reloaded mid paste-read)
        const textLength = readerState.textLength || 0;
        return {
            isPage: false,
            text: "",
            textLength,
            wordCount: Math.round(textLength / 5.5),
            sentenceRanges: []
        };
    }

    function getDockTitle(sourceKind) {
        if (sourceKind === "paste") {
            return "Pasted text";
        }
        if (sourceKind === "selection") {
            return "Selected text";
        }
        return getControllerTitle();
    }

    function getDockSubtitle(readerState, textModel) {
        const voiceLabel = formatVoiceName(readerState?.voiceName);
        if (!textModel.sentenceRanges.length) {
            return voiceLabel;
        }

        const currentOffset = clamp(Number(readerState?.currentOffset) || 0, 0, textModel.textLength);
        const index = findSentenceIndexForOffset(currentOffset, textModel.sentenceRanges);
        const sentenceNumber = index >= 0 ? index + 1 : 1;
        return `Sentence ${sentenceNumber} of ${textModel.sentenceRanges.length} · ${voiceLabel}`;
    }

    function renderSpeedControl(controller, rate) {
        const activeRate = RATE_STEPS.includes(rate) ? rate : "+0%";
        controller.querySelectorAll(`#${CONTROLLER_SPEED_ID} [data-rate]`).forEach((button) => {
            button.setAttribute("aria-pressed", button.dataset.rate === activeRate ? "true" : "false");
        });
    }

    function updateFloatingController(readerState) {
        const isSpeaking = Boolean(readerState && readerState.isSpeaking);
        const isPaused = Boolean(readerState && readerState.isPaused);
        const isLoading = Boolean(readerState && !isSpeaking && !isPaused && readerState.isActiveTab);
        const isActiveSession = isSpeaking || isPaused || isLoading;

        if (isActiveSession) {
            state.dockEverShown = true;
            state.dockDismissed = false;
        }

        const shouldShow = isActiveSession || state.dockPasteOpen || (state.dockEverShown && !state.dockDismissed);
        if (!shouldShow) {
            hideFloatingController();
            return;
        }

        const controller = ensureFloatingController();
        const textModel = getActiveTextModel();
        const sourceKind = readerState?.sourceKind || "page";
        const navigationDisabled = textModel.textLength === 0;

        const title = controller.querySelector(`#${CONTROLLER_TITLE_ID}`);
        const subtitle = controller.querySelector(`#${CONTROLLER_SUBTITLE_ID}`);
        const status = controller.querySelector(`#${CONTROLLER_STATUS_ID}`);
        const voice = controller.querySelector(`#${CONTROLLER_VOICE_ID}`);
        const seekInput = controller.querySelector(`#${CONTROLLER_SEEK_ID}`);
        const toggleButton = controller.querySelector(`#${CONTROLLER_TOGGLE_ID}`);

        title.textContent = getDockTitle(sourceKind);
        title.title = title.textContent;
        subtitle.textContent = getDockSubtitle(readerState, textModel);
        renderControllerVoiceOptions(readerState?.voiceName);
        voice.title = formatVoiceLabel(readerState?.voiceName);
        void ensureControllerVoices();
        renderSpeedControl(controller, readerState?.rate);

        let dockState;
        let statusText;
        let toggleIcon;
        let toggleLabel;
        let toggleExtraDisabled = false;

        if (isSpeaking) {
            dockState = "reading";
            statusText = "Reading";
            toggleIcon = "pause";
            toggleLabel = "Pause playback";
        } else if (isPaused) {
            dockState = "paused";
            statusText = "Paused";
            toggleIcon = "play";
            toggleLabel = "Resume playback";
        } else if (isLoading) {
            dockState = "loading";
            statusText = "Preparing";
            toggleIcon = "pause";
            toggleLabel = "Pause playback";
            toggleExtraDisabled = true;
        } else {
            dockState = "idle";
            statusText = "Ready";
            toggleIcon = "play";
            toggleLabel = "Start reading";
        }

        controller.dataset.state = dockState;
        // Idle: seeking is meaningless, but play (main button and pill button) starts reading from the top.
        const transportDisabled = dockState === "idle" ? true : navigationDisabled;
        const pillToggle = controller.querySelector(`#${CONTROLLER_PILL_TOGGLE_ID}`);

        status.textContent = statusText;
        toggleButton.innerHTML = controllerIcon(toggleIcon);
        toggleButton.disabled = navigationDisabled || toggleExtraDisabled;
        toggleButton.setAttribute("aria-label", toggleLabel);
        pillToggle.innerHTML = controllerIcon(toggleIcon);
        pillToggle.disabled = navigationDisabled || toggleExtraDisabled;
        pillToggle.setAttribute("aria-label", toggleLabel);
        seekInput.disabled = transportDisabled;
        controller.querySelector(`#${CONTROLLER_REWIND_ID}`).disabled = transportDisabled;
        controller.querySelector(`#${CONTROLLER_PREVIOUS_ID}`).disabled = transportDisabled;
        controller.querySelector(`#${CONTROLLER_NEXT_ID}`).disabled = transportDisabled;
        controller.querySelector(`#${CONTROLLER_FORWARD_ID}`).disabled = transportDisabled;

        const pasteOpen = state.dockPasteOpen;
        controller.dataset.mode = pasteOpen ? "paste" : (state.dockCollapsed ? "collapsed" : "expanded");

        syncFloatingControllerProgress(readerState);

        controller.hidden = false;
    }

    function hideFloatingController() {
        const controller = document.getElementById(CONTROLLER_ID);
        if (!controller) {
            return;
        }

        state.isScrubbing = false;
        controller.hidden = true;
    }

    function syncFloatingControllerProgress(readerState) {
        const controller = document.getElementById(CONTROLLER_ID);
        if (!controller || !readerState) {
            return;
        }

        const textModel = getActiveTextModel();
        const seekInput = controller.querySelector(`#${CONTROLLER_SEEK_ID}`);
        const currentTime = controller.querySelector(`#${CONTROLLER_CURRENT_TIME_ID}`);
        const totalTime = controller.querySelector(`#${CONTROLLER_TOTAL_TIME_ID}`);
        const pillRing = controller.querySelector(`#${CONTROLLER_PILL_RING_ID}`);
        const pillLabel = controller.querySelector(`#${CONTROLLER_PILL_LABEL_ID}`);
        const totalLength = textModel.textLength;
        const liveOffset = clamp(Number(readerState.currentOffset) || 0, 0, totalLength);
        const displayOffset = state.isScrubbing
            ? offsetFromProgressRatio(totalLength, state.scrubRatio)
            : liveOffset;
        const progressRatio = totalLength > 0 ? displayOffset / totalLength : 0;
        const totalSeconds = estimateTotalDurationSeconds(textModel, readerState.rate);
        const currentSeconds = totalSeconds * progressRatio;

        if (!state.isScrubbing) {
            seekInput.value = String(Math.round(progressRatio * 1000));
        }

        paintSeekTrack(seekInput, progressRatio);
        currentTime.textContent = formatClockLabel(currentSeconds);
        totalTime.textContent = formatClockLabel(totalSeconds);

        const isIdle = controller.dataset.state === "idle";
        const ringPercent = isIdle ? "0%" : `${Math.round(progressRatio * 100)}%`;
        if (pillRing) {
            pillRing.style.setProperty("--cd-ring", ringPercent);
        }
        if (pillLabel) {
            pillLabel.textContent = isIdle ? "Cadence" : formatClockLabel(currentSeconds);
        }
    }

    async function ensureControllerVoices() {
        if (state.availableVoices.length) {
            return state.availableVoices;
        }

        if (state.voicesPromise) {
            return state.voicesPromise;
        }

        state.voicesPromise = chrome.runtime.sendMessage({ type: "GET_BACKEND_VOICES" })
            .then((response) => {
                if (!response || !response.ok) {
                    throw new Error(response?.error || "Could not load Edge TTS voices.");
                }

                state.availableVoices = Array.isArray(response.voices) ? response.voices : [];
                state.voiceLoadErrorShown = false;
                if (state.readerState) {
                    renderControllerVoiceOptions(state.readerState.voiceName);
                }
                return state.availableVoices;
            })
            .catch((error) => {
                if (!state.voiceLoadErrorShown) {
                    showToast(error.message || "Could not load Edge TTS voices.");
                    state.voiceLoadErrorShown = true;
                }
                return [];
            })
            .finally(() => {
                state.voicesPromise = null;
            });

        return state.voicesPromise;
    }

    function renderControllerVoiceOptions(selectedVoiceName) {
        const controller = document.getElementById(CONTROLLER_ID);
        if (!controller) {
            return;
        }

        const voiceSelect = controller.querySelector(`#${CONTROLLER_VOICE_ID}`);
        if (!voiceSelect) {
            return;
        }

        const safeSelectedVoice = selectedVoiceName || "en-US-AriaNeural";
        let options = state.availableVoices.length
            ? state.availableVoices
            : [{ name: safeSelectedVoice, locale: "" }];

        if (!options.some((voice) => voice.name === safeSelectedVoice)) {
            options = [{ name: safeSelectedVoice, locale: "" }, ...options];
        }

        voiceSelect.innerHTML = "";
        options.forEach((voice) => {
            const option = document.createElement("option");
            option.value = voice.name;
            option.textContent = formatVoiceName(voice.name);
            option.title = voice.locale ? `${voice.name} (${voice.locale})` : voice.name;
            voiceSelect.appendChild(option);
        });

        voiceSelect.value = safeSelectedVoice;
        voiceSelect.disabled = !state.availableVoices.length;
        voiceSelect.title = formatVoiceLabel(safeSelectedVoice);
    }

    async function updateFloatingSetting(settings, successMessage) {
        try {
            const response = await chrome.runtime.sendMessage({
                type: "UPDATE_SETTINGS",
                settings
            });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Settings update failed.");
            }
            if (response.state) {
                applyReaderState(response.state);
            }
            if (successMessage) {
                showToast(successMessage);
            }
        } catch (error) {
            showToast(error.message || "Settings update failed.");
        }
    }

    async function commitControllerSeekFromSlider() {
        if (!state.readerState) {
            return;
        }

        const textModel = getActiveTextModel();
        const targetOffset = offsetFromProgressRatio(textModel.textLength, state.scrubRatio);
        state.isScrubbing = false;
        await requestFloatingSeek(targetOffset, { autoplay: state.readerState.isSpeaking });
    }

    async function seekByEstimatedSeconds(deltaSeconds) {
        if (!state.readerState) {
            return;
        }

        const textModel = getActiveTextModel();
        const totalSeconds = estimateTotalDurationSeconds(textModel, state.readerState.rate);
        if (!textModel.textLength || !totalSeconds) {
            return;
        }

        const currentOffset = clamp(Number(state.readerState.currentOffset) || 0, 0, textModel.textLength);
        const currentSeconds = totalSeconds * (currentOffset / textModel.textLength);
        const targetSeconds = clamp(currentSeconds + deltaSeconds, 0, totalSeconds);
        const targetOffset = offsetFromProgressRatio(textModel.textLength, targetSeconds / totalSeconds);
        await requestFloatingSeek(targetOffset, { autoplay: state.readerState.isSpeaking });
    }

    async function seekBySentence(direction) {
        if (!state.readerState) {
            return;
        }

        const textModel = getActiveTextModel();
        const sentenceRanges = textModel.sentenceRanges;
        if (!sentenceRanges.length) {
            return;
        }

        const currentOffset = clamp(Number(state.readerState.currentOffset) || 0, 0, textModel.textLength);
        const currentIndex = findSentenceIndexForOffset(currentOffset, sentenceRanges);
        if (currentIndex < 0) {
            return;
        }

        let nextIndex = currentIndex;
        if (direction < 0) {
            const currentSentence = sentenceRanges[currentIndex];
            nextIndex = currentOffset - currentSentence.start > 12
                ? currentIndex
                : Math.max(0, currentIndex - 1);
        } else if (direction > 0) {
            nextIndex = Math.min(sentenceRanges.length - 1, currentIndex + 1);
        }

        await requestFloatingSeek(sentenceRanges[nextIndex].start, { autoplay: state.readerState.isSpeaking });
    }

    async function requestFloatingSeek(targetOffset, options = {}) {
        if (!state.readerState) {
            return;
        }

        const textModel = getActiveTextModel();
        const normalizedOffset = textModel.text
            ? snapSeekOffset(textModel.text, targetOffset)
            : clamp(Number(targetOffset) || 0, 0, textModel.textLength);
        const autoplay = typeof options.autoplay === "boolean"
            ? options.autoplay
            : state.readerState.isSpeaking;

        state.readerState.currentOffset = normalizedOffset;
        syncFloatingControllerProgress(state.readerState);
        if (textModel.isPage) {
            highlightOffset(normalizedOffset);
        }

        try {
            const response = await chrome.runtime.sendMessage({
                type: "FLOATING_SEEK_READING",
                offset: normalizedOffset,
                autoplay
            });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Seek failed.");
            }
            if (response.state) {
                applyReaderState(response.state);
            }
        } catch (error) {
            showToast(error.message || "Seek failed.");
            try {
                const response = await chrome.runtime.sendMessage({ type: "GET_TAB_STATE" });
                if (response && response.ok && response.state) {
                    applyReaderState(response.state);
                }
            } catch (refreshError) {
                // Ignore state refresh failures after a seek error.
            }
        }
    }

    function offsetFromProgressRatio(totalLength, ratio) {
        if (!totalLength) {
            return 0;
        }

        return clamp(Math.round(totalLength * clamp(ratio, 0, 1)), 0, totalLength);
    }

    function paintSeekTrack(seekInput, ratio) {
        const progress = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
        seekInput.style.setProperty("--twelve-reader-progress", progress);
    }

    function snapSeekOffset(text, rawOffset) {
        const safeText = text || "";
        let offset = clamp(Number(rawOffset) || 0, 0, safeText.length);
        if (!safeText || offset <= 0 || offset >= safeText.length) {
            return offset;
        }

        while (offset > 0 && /\S/.test(safeText[offset - 1]) && /\S/.test(safeText[offset])) {
            offset -= 1;
        }

        while (offset < safeText.length && /\s/.test(safeText[offset])) {
            offset += 1;
        }

        return clamp(offset, 0, safeText.length);
    }

    function findSentenceIndexForOffset(offset, sentenceRanges) {
        for (let index = 0; index < sentenceRanges.length; index += 1) {
            const range = sentenceRanges[index];
            if (offset >= range.start && offset < range.end) {
                return index;
            }
        }

        if (!sentenceRanges.length) {
            return -1;
        }

        return offset >= sentenceRanges[sentenceRanges.length - 1].end
            ? sentenceRanges.length - 1
            : 0;
    }

    function estimateTotalDurationSeconds(readingMap, rate) {
        if (!readingMap.wordCount) {
            return 0;
        }

        const baseWordsPerMinute = 170;
        return (readingMap.wordCount / (baseWordsPerMinute * rateToPlaybackMultiplier(rate))) * 60;
    }

    function rateToPlaybackMultiplier(rate) {
        const match = /^([+-])(\d+)%$/.exec(rate || "+0%");
        if (!match) {
            return 1;
        }

        const direction = match[1] === "+" ? 1 : -1;
        const amount = Number(match[2]) / 100;
        return clamp(1 + direction * amount, 0.5, 2);
    }

    function formatClockLabel(seconds) {
        const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const remainder = totalSeconds % 60;
        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
        }

        return `${minutes}:${String(remainder).padStart(2, "0")}`;
    }

    function countWords(text) {
        const matches = (text || "").match(/\S+/g);
        return matches ? matches.length : 0;
    }

    function getControllerTitle() {
        const title = (document.title || "").trim();
        if (title) {
            return title;
        }

        const hostname = safeHostname(location.href);
        return hostname || "Current page";
    }

    function safeHostname(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch (error) {
            return "";
        }
    }

    function formatRateLabel(rate) {
        return RATE_LABELS[rate] || "1.0×";
    }

    function formatVoiceName(voiceName) {
        if (!voiceName) {
            return "Default voice";
        }

        const segments = voiceName.split("-");
        const rawName = segments[2] || voiceName;
        return rawName
            .replace(/Neural$/i, "")
            .replace(/([a-z])([A-Z])/g, "$1 $2");
    }

    function formatVoiceLabel(voiceName) {
        if (!voiceName) {
            return "Default voice";
        }

        const segments = voiceName.split("-");
        const locale = segments.length >= 2 ? `${segments[0]}-${segments[1]}`.toUpperCase() : "";
        const name = formatVoiceName(voiceName);
        return locale ? `${name} (${locale})` : name;
    }

    function controllerIcon(name) {
        const icons = {
            play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"></path></svg>',
            pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"></path></svg>',
            previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm12 0L8 12l10 6z"></path></svg>',
            next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM6 6l10 6-10 6z"></path></svg>',
            rewind: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 0 6.6 9.3h-2.2A5 5 0 1 1 12 7h1.8L11 9.8 12.4 11 18 5.4 12.4-.2 11 1.2 13.8 4H12z"></path><text x="12" y="18" text-anchor="middle" font-size="6" font-family="Arial, sans-serif">15</text></svg>',
            forward: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.6 9.3h2.2A5 5 0 1 0 12 7h-1.8L13 9.8 11.6 11 6 5.4 11.6-.2 13 1.2 10.2 4H12z"></path><text x="12" y="18" text-anchor="middle" font-size="6" font-family="Arial, sans-serif">15</text></svg>',
            chevronUp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14l6-6 6 6z"></path></svg>',
            chevronDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10l6 6 6-6z"></path></svg>',
            clipboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2m2-2h4v4h-4z"></path></svg>'
        };

        return icons[name] || "";
    }

    async function handleTogglePlayback() {
        try {
            const response = await chrome.runtime.sendMessage({ type: "FLOATING_TOGGLE_PLAYBACK" });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Playback control failed.");
            }
            if (response.state) {
                applyReaderState(response.state);
            }
        } catch (error) {
            showToast(error.message || "Playback control failed.");
        }
    }

    async function handleStartReadingTop() {
        try {
            const response = await chrome.runtime.sendMessage({ type: "START_READING_TOP" });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Could not start reading.");
            }
            if (response.state) {
                applyReaderState(response.state);
            }
        } catch (error) {
            showToast(error.message || "Could not start reading.");
        }
    }

    // Shared by "Read selection only" and the paste panel's "Read this text" (§4/§5 READ_TEXT).
    async function sendReadTextAction(text, source) {
        state.externalText = text;
        try {
            const response = await chrome.runtime.sendMessage({ type: "READ_TEXT", text, source });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Could not read this text.");
            }
            state.dockCollapsed = false;
            state.dockPasteOpen = false;
            if (response.state) {
                applyReaderState(response.state);
            } else {
                updateFloatingController(state.readerState);
            }
            return true;
        } catch (error) {
            showToast(error.message || "Could not read this text.");
            return false;
        }
    }

    // Opens the paste panel; when `text` is given it is appended to any existing draft (§4 send-to-paste).
    function openPastePanel(text) {
        const controller = ensureFloatingController();
        if (text) {
            const textarea = controller.querySelector(`#${CONTROLLER_PASTE_INPUT_ID}`);
            textarea.value = textarea.value.trim() ? `${textarea.value}\n\n${text}` : text;
        }
        state.dockPasteOpen = true;
        state.dockCollapsed = false;
        state.dockDismissed = false;
        state.dockEverShown = true;
        updateFloatingController(state.readerState);
        controller.querySelector(`#${CONTROLLER_PASTE_INPUT_ID}`).focus();
    }

    function ensureFloatingController() {
        let controller = document.getElementById(CONTROLLER_ID);
        if (controller) {
            return controller;
        }

        controller = document.createElement("div");
        controller.id = CONTROLLER_ID;
        controller.hidden = true;
        controller.dataset.mode = "expanded";
        controller.dataset.state = "idle";
        controller.innerHTML = `
            <div class="twelve-reader-controller__header">
                <span id="${CONTROLLER_STATUS_ID}" class="twelve-reader-controller__status" aria-live="polite">Ready</span>
                <div class="twelve-reader-controller__header-actions">
                    <button id="${CONTROLLER_COLLAPSE_ID}" type="button" class="twelve-reader-controller__header-btn" aria-label="Collapse Cadence">${controllerIcon("chevronUp")}</button>
                    <button id="${CONTROLLER_CLOSE_ID}" type="button" class="twelve-reader-controller__header-btn" aria-label="Close Cadence">&times;</button>
                </div>
            </div>
            <div class="twelve-reader-controller__body">
                <div class="twelve-reader-controller__meta">
                    <span id="${CONTROLLER_TITLE_ID}" class="twelve-reader-controller__title">Current page</span>
                    <span id="${CONTROLLER_SUBTITLE_ID}" class="twelve-reader-controller__subtitle">Default voice</span>
                </div>
                <div class="twelve-reader-controller__transport-row">
                    <button id="${CONTROLLER_REWIND_ID}" type="button" class="twelve-reader-controller__icon-button" aria-label="Jump back 15 seconds" data-control-action="rewind">${controllerIcon("rewind")}</button>
                    <button id="${CONTROLLER_PREVIOUS_ID}" type="button" class="twelve-reader-controller__icon-button" aria-label="Previous sentence" data-control-action="previous">${controllerIcon("previous")}</button>
                    <button id="${CONTROLLER_TOGGLE_ID}" type="button" class="twelve-reader-controller__play-button" aria-label="Pause playback">${controllerIcon("pause")}</button>
                    <button id="${CONTROLLER_NEXT_ID}" type="button" class="twelve-reader-controller__icon-button" aria-label="Next sentence" data-control-action="next">${controllerIcon("next")}</button>
                    <button id="${CONTROLLER_FORWARD_ID}" type="button" class="twelve-reader-controller__icon-button" aria-label="Jump forward 15 seconds" data-control-action="forward">${controllerIcon("forward")}</button>
                </div>
                <div class="twelve-reader-controller__timeline">
                    <span id="${CONTROLLER_CURRENT_TIME_ID}" class="twelve-reader-controller__time">0:00</span>
                    <input id="${CONTROLLER_SEEK_ID}" class="twelve-reader-controller__seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek reading position">
                    <span id="${CONTROLLER_TOTAL_TIME_ID}" class="twelve-reader-controller__time">0:00</span>
                </div>
                <div class="twelve-reader-controller__settings">
                    <div class="twelve-reader-controller__setting">
                        <label class="twelve-reader-controller__setting-label" for="${CONTROLLER_VOICE_ID}">Voice</label>
                        <select id="${CONTROLLER_VOICE_ID}" class="twelve-reader-controller__voice-select" disabled>
                            <option>Loading voices...</option>
                        </select>
                    </div>
                    <div class="twelve-reader-controller__setting">
                        <span class="twelve-reader-controller__setting-label">Speed</span>
                        <div id="${CONTROLLER_SPEED_ID}" class="twelve-reader-controller__speed" role="group" aria-label="Playback speed">
                            <button type="button" class="twelve-reader-controller__speed-btn" data-rate="-25%" aria-pressed="false">0.75×</button>
                            <button type="button" class="twelve-reader-controller__speed-btn" data-rate="+0%" aria-pressed="true">1.0×</button>
                            <button type="button" class="twelve-reader-controller__speed-btn" data-rate="+25%" aria-pressed="false">1.25×</button>
                            <button type="button" class="twelve-reader-controller__speed-btn" data-rate="+50%" aria-pressed="false">1.5×</button>
                        </div>
                    </div>
                </div>
                <button id="${CONTROLLER_PASTE_OPEN_ID}" type="button" class="twelve-reader-controller__paste-open">${controllerIcon("clipboard")}<span>Paste text to read</span></button>
            </div>
            <div class="twelve-reader-controller__paste">
                <div class="twelve-reader-controller__paste-header">
                    <span class="twelve-reader-controller__paste-label">Paste text</span>
                    <button id="${CONTROLLER_PASTE_CLOSE_ID}" type="button" class="twelve-reader-controller__header-btn" aria-label="Close paste panel">&times;</button>
                </div>
                <div class="twelve-reader-controller__paste-body">
                    <textarea id="${CONTROLLER_PASTE_INPUT_ID}" class="twelve-reader-controller__paste-textarea" rows="4" placeholder="Paste or type text to read..."></textarea>
                    <div class="twelve-reader-controller__paste-actions">
                        <button id="${CONTROLLER_PASTE_READ_ID}" type="button" class="twelve-reader-controller__paste-read">Read this text</button>
                        <button id="${CONTROLLER_PASTE_CLEAR_ID}" type="button" class="twelve-reader-controller__paste-clear">Clear</button>
                    </div>
                </div>
            </div>
            <div class="twelve-reader-controller__pill">
                <div id="${CONTROLLER_PILL_RING_ID}" class="twelve-reader-controller__pill-ring">
                    <button id="${CONTROLLER_PILL_TOGGLE_ID}" type="button" class="twelve-reader-controller__pill-toggle" aria-label="Start reading">${controllerIcon("play")}</button>
                </div>
                <span id="${CONTROLLER_PILL_LABEL_ID}" class="twelve-reader-controller__pill-label">Cadence</span>
                <button id="${CONTROLLER_EXPAND_ID}" type="button" class="twelve-reader-controller__header-btn" aria-label="Expand Cadence">${controllerIcon("chevronDown")}</button>
            </div>
        `;

        const onToggleClick = () => {
            if (controller.dataset.state === "idle") {
                void handleStartReadingTop();
            } else {
                void handleTogglePlayback();
            }
        };
        controller.querySelector(`#${CONTROLLER_TOGGLE_ID}`).addEventListener("click", onToggleClick);
        controller.querySelector(`#${CONTROLLER_PILL_TOGGLE_ID}`).addEventListener("click", onToggleClick);

        controller.querySelector(`#${CONTROLLER_CLOSE_ID}`).addEventListener("click", async () => {
            // Dismiss first: the stop round-trip broadcasts an idle state, which would otherwise re-show the standby pill.
            state.dockDismissed = true;
            state.dockPasteOpen = false;
            hideFloatingController();
            try {
                const response = await chrome.runtime.sendMessage({ type: "FLOATING_STOP_READING" });
                if (!response || !response.ok) {
                    throw new Error(response?.error || "Terminate failed.");
                }
            } catch (error) {
                state.dockDismissed = false;
                updateFloatingController(state.readerState);
                showToast(error.message || "Terminate failed.");
            }
        });

        controller.querySelector(`#${CONTROLLER_COLLAPSE_ID}`).addEventListener("click", () => {
            state.dockCollapsed = true;
            updateFloatingController(state.readerState);
        });

        controller.querySelector(`#${CONTROLLER_EXPAND_ID}`).addEventListener("click", () => {
            state.dockCollapsed = false;
            updateFloatingController(state.readerState);
        });

        controller.querySelector(`#${CONTROLLER_REWIND_ID}`).addEventListener("click", () => {
            void seekByEstimatedSeconds(-15);
        });

        controller.querySelector(`#${CONTROLLER_PREVIOUS_ID}`).addEventListener("click", () => {
            void seekBySentence(-1);
        });

        controller.querySelector(`#${CONTROLLER_NEXT_ID}`).addEventListener("click", () => {
            void seekBySentence(1);
        });

        controller.querySelector(`#${CONTROLLER_FORWARD_ID}`).addEventListener("click", () => {
            void seekByEstimatedSeconds(15);
        });

        const seekInput = controller.querySelector(`#${CONTROLLER_SEEK_ID}`);
        seekInput.addEventListener("input", () => {
            state.isScrubbing = true;
            state.scrubRatio = clamp(Number(seekInput.value) / 1000, 0, 1);
            if (state.readerState) {
                syncFloatingControllerProgress(state.readerState);
            }
        });

        seekInput.addEventListener("change", () => {
            void commitControllerSeekFromSlider();
        });

        seekInput.addEventListener("blur", () => {
            if (!state.isScrubbing || !state.readerState) {
                return;
            }

            state.isScrubbing = false;
            syncFloatingControllerProgress(state.readerState);
        });

        controller.querySelector(`#${CONTROLLER_SPEED_ID}`).addEventListener("click", async (event) => {
            const button = event.target.closest("[data-rate]");
            if (!button) {
                return;
            }
            const nextRate = RATE_STEPS.includes(button.dataset.rate) ? button.dataset.rate : "+0%";
            await updateFloatingSetting({ rate: nextRate }, `Speed set to ${formatRateLabel(nextRate)}.`);
        });

        controller.querySelector(`#${CONTROLLER_VOICE_ID}`).addEventListener("change", async (event) => {
            if (!event.target.value) {
                return;
            }
            await updateFloatingSetting({ voiceName: event.target.value }, `Voice set to ${formatVoiceName(event.target.value)}.`);
        });

        controller.querySelector(`#${CONTROLLER_PASTE_OPEN_ID}`).addEventListener("click", () => {
            openPastePanel(null);
        });

        controller.querySelector(`#${CONTROLLER_PASTE_CLOSE_ID}`).addEventListener("click", () => {
            state.dockPasteOpen = false;
            state.dockCollapsed = false;
            updateFloatingController(state.readerState);
        });

        controller.querySelector(`#${CONTROLLER_PASTE_CLEAR_ID}`).addEventListener("click", () => {
            const textarea = controller.querySelector(`#${CONTROLLER_PASTE_INPUT_ID}`);
            textarea.value = "";
            textarea.focus();
        });

        controller.querySelector(`#${CONTROLLER_PASTE_READ_ID}`).addEventListener("click", async () => {
            const textarea = controller.querySelector(`#${CONTROLLER_PASTE_INPUT_ID}`);
            const text = textarea.value.trim();
            if (!text) {
                showToast("Paste some text first.");
                return;
            }
            await sendReadTextAction(text, "paste");
        });

        document.documentElement.appendChild(controller);
        void ensureControllerVoices();
        return controller;
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: absolute;
                inset: 0 auto auto 0;
                pointer-events: none;
                z-index: 2147483646;
            }

            .twelve-reader-highlight {
                position: absolute;
                border-radius: 5px;
                pointer-events: none;
            }

            .twelve-reader-highlight.sentence {
                background: rgba(249, 203, 61, 0.28);
            }

            .twelve-reader-highlight.word {
                background: rgba(234, 94, 42, 0.38);
            }

            #${CONTROLLER_ID} {
                --cd-font: system-ui, -apple-system, "Segoe UI", sans-serif;
                --cd-serif: Georgia, "Times New Roman", serif;
                --cd-text: #111827;
                --cd-muted: #8a8f98;
                --cd-idle-icon: #b2b8c2;
                --cd-accent: #d9642e;
                --cd-accent-strong: #b74e20;
                --cd-surface: #ffffff;
                --cd-field: #f6f7f9;
                --cd-hover: #f3f4f6;
                --cd-border: rgba(89, 102, 129, 0.14);
                --cd-field-border: rgba(17, 24, 39, 0.08);
                --cd-ink: #090909;
                --cd-track: rgba(17, 17, 17, 0.12);
                --cd-shadow-card: 0 24px 55px rgba(15, 23, 42, 0.18);
                --cd-shadow-pill: 0 18px 40px rgba(15, 23, 42, 0.16);
                --cd-shadow-play: 0 14px 22px rgba(17, 17, 17, 0.18);

                position: fixed;
                right: 20px;
                bottom: 20px;
                z-index: 2147483647;
                width: 332px;
                max-width: calc(100vw - 32px);
                max-height: calc(100vh - 40px);
                display: flex;
                flex-direction: column;
                border-radius: 24px;
                background: rgba(255, 255, 255, 0.98);
                border: 1px solid var(--cd-border);
                box-shadow: var(--cd-shadow-card);
                color: var(--cd-text);
                font: 500 14px/1.4 var(--cd-font);
                overflow: hidden;
            }

            #${CONTROLLER_ID}[hidden] {
                display: none;
            }

            #${CONTROLLER_ID},
            #${CONTROLLER_ID} * {
                box-sizing: border-box;
            }

            #${CONTROLLER_ID} button,
            #${CONTROLLER_ID} select,
            #${CONTROLLER_ID} textarea {
                font-family: var(--cd-font);
            }

            #${CONTROLLER_ID} svg {
                fill: currentColor;
                pointer-events: none;
            }

            #${CONTROLLER_ID} button:focus-visible,
            #${CONTROLLER_ID} select:focus-visible,
            #${CONTROLLER_ID} textarea:focus-visible,
            #${CONTROLLER_ID} input:focus-visible {
                outline: 2px solid var(--cd-accent);
                outline-offset: 2px;
            }

            .twelve-reader-controller__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 14px 16px;
                border-bottom: 1px solid var(--cd-border);
                flex-shrink: 0;
            }

            .twelve-reader-controller__status {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.1em;
                text-transform: uppercase;
                color: var(--cd-muted);
            }

            .twelve-reader-controller__status::before {
                content: "";
                width: 6px;
                height: 6px;
                border-radius: 999px;
                background: currentColor;
                flex-shrink: 0;
            }

            #${CONTROLLER_ID}[data-state="reading"] .twelve-reader-controller__status {
                color: var(--cd-accent-strong);
            }

            #${CONTROLLER_ID}[data-state="reading"] .twelve-reader-controller__status::before {
                animation: cadence-pulse 1.6s ease-in-out infinite;
            }

            @keyframes cadence-pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.35; }
            }

            .twelve-reader-controller__header-actions {
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .twelve-reader-controller__header-btn {
                appearance: none;
                width: 32px;
                height: 32px;
                border: 0;
                border-radius: 999px;
                background: transparent;
                color: var(--cd-muted);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font: 500 20px/1 var(--cd-font);
                cursor: pointer;
                transition: background 160ms ease, color 160ms ease;
            }

            .twelve-reader-controller__header-btn svg {
                width: 18px;
                height: 18px;
            }

            .twelve-reader-controller__header-btn:hover {
                background: var(--cd-hover);
                color: var(--cd-text);
            }

            .twelve-reader-controller__body {
                display: flex;
                flex-direction: column;
                flex: 1 1 auto;
                min-height: 0;
                padding: 18px 16px 16px;
                overflow-y: auto;
            }

            #${CONTROLLER_ID}[data-mode="paste"] .twelve-reader-controller__body {
                display: none;
            }

            .twelve-reader-controller__meta {
                display: flex;
                flex-direction: column;
                gap: 4px;
                min-width: 0;
                margin-bottom: 16px;
            }

            .twelve-reader-controller__title {
                font: 700 19px/1.2 var(--cd-serif);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .twelve-reader-controller__subtitle {
                font-size: 12px;
                color: var(--cd-muted);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .twelve-reader-controller__transport-row {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                margin-bottom: 16px;
            }

            .twelve-reader-controller__icon-button,
            .twelve-reader-controller__play-button {
                appearance: none;
                border: 0;
                padding: 0;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: transform 160ms ease, background 160ms ease, color 160ms ease, opacity 160ms ease;
            }

            .twelve-reader-controller__icon-button {
                width: 42px;
                height: 42px;
                border-radius: 999px;
                background: transparent;
                color: var(--cd-idle-icon);
            }

            .twelve-reader-controller__icon-button svg {
                width: 20px;
                height: 20px;
            }

            .twelve-reader-controller__icon-button:hover:not(:disabled) {
                background: var(--cd-hover);
                color: var(--cd-text);
            }

            .twelve-reader-controller__icon-button:disabled,
            .twelve-reader-controller__play-button:disabled {
                opacity: 0.45;
                cursor: default;
                transform: none;
            }

            .twelve-reader-controller__play-button {
                width: 62px;
                height: 62px;
                border-radius: 22px;
                background: var(--cd-ink);
                color: #ffffff;
                box-shadow: var(--cd-shadow-play);
            }

            .twelve-reader-controller__play-button svg {
                width: 26px;
                height: 26px;
            }

            .twelve-reader-controller__play-button:hover:not(:disabled) {
                background: #000000;
            }

            .twelve-reader-controller__timeline {
                display: grid;
                grid-template-columns: auto minmax(0, 1fr) auto;
                align-items: center;
                gap: 10px;
                margin-bottom: 16px;
            }

            .twelve-reader-controller__time {
                font-size: 11px;
                color: var(--cd-muted);
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
            }

            .twelve-reader-controller__seek {
                --twelve-reader-progress: 0%;
                width: 100%;
                height: 20px;
                margin: 0;
                background: transparent;
                cursor: pointer;
                appearance: none;
                -webkit-appearance: none;
            }

            .twelve-reader-controller__seek:focus {
                outline: none;
            }

            .twelve-reader-controller__seek:disabled {
                cursor: default;
                opacity: 0.5;
            }

            .twelve-reader-controller__seek::-webkit-slider-runnable-track {
                height: 2px;
                background: linear-gradient(to right, var(--cd-accent) 0%, var(--cd-accent) var(--twelve-reader-progress), var(--cd-track) var(--twelve-reader-progress), var(--cd-track) 100%);
            }

            .twelve-reader-controller__seek::-webkit-slider-thumb {
                width: 14px;
                height: 14px;
                margin-top: -6px;
                border: 0;
                border-radius: 999px;
                background: #111111;
                box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.96);
                appearance: none;
                -webkit-appearance: none;
            }

            .twelve-reader-controller__seek::-moz-range-track {
                height: 2px;
                background: var(--cd-track);
            }

            .twelve-reader-controller__seek::-moz-range-progress {
                height: 2px;
                background: var(--cd-accent);
            }

            .twelve-reader-controller__seek::-moz-range-thumb {
                width: 14px;
                height: 14px;
                border: 0;
                border-radius: 999px;
                background: #111111;
                box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.96);
            }

            .twelve-reader-controller__settings {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
            }

            .twelve-reader-controller__setting {
                display: flex;
                flex-direction: column;
                gap: 6px;
                min-width: 0;
            }

            .twelve-reader-controller__setting-label {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.1em;
                text-transform: uppercase;
                color: var(--cd-muted);
            }

            .twelve-reader-controller__voice-select {
                min-height: 40px;
                padding: 0 32px 0 12px;
                border: 1px solid var(--cd-field-border);
                border-radius: 999px;
                background-color: var(--cd-field);
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%237a818d' d='M6 10l6 6 6-6z'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 10px center;
                background-size: 14px;
                color: var(--cd-text);
                font: 700 14px/1.2 var(--cd-font);
                appearance: none;
                -webkit-appearance: none;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                transition: border-color 160ms ease, background-color 160ms ease;
            }

            .twelve-reader-controller__voice-select:hover:not(:disabled) {
                border-color: rgba(17, 24, 39, 0.16);
            }

            .twelve-reader-controller__voice-select:disabled {
                cursor: default;
                opacity: 0.7;
            }

            .twelve-reader-controller__speed {
                display: flex;
                padding: 3px;
                border-radius: 999px;
                background: var(--cd-field);
                border: 1px solid var(--cd-field-border);
            }

            .twelve-reader-controller__speed-btn {
                appearance: none;
                flex: 1;
                height: 34px;
                border: 0;
                border-radius: 999px;
                background: transparent;
                color: var(--cd-muted);
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                transition: background 160ms ease, color 160ms ease;
            }

            .twelve-reader-controller__speed-btn[aria-pressed="true"] {
                background: var(--cd-accent);
                color: #ffffff;
            }

            .twelve-reader-controller__paste-open {
                appearance: none;
                width: 100%;
                min-height: 44px;
                margin-top: 14px;
                border: 1px dashed rgba(17, 24, 39, 0.22);
                border-radius: 14px;
                background: transparent;
                color: var(--cd-muted);
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.14em;
                text-transform: uppercase;
                cursor: pointer;
                transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
            }

            .twelve-reader-controller__paste-open svg {
                width: 16px;
                height: 16px;
            }

            .twelve-reader-controller__paste-open:hover {
                background: var(--cd-field);
                border-color: var(--cd-accent);
                color: var(--cd-accent-strong);
            }

            .twelve-reader-controller__paste {
                display: none;
                flex-direction: column;
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
            }

            #${CONTROLLER_ID}[data-mode="paste"] .twelve-reader-controller__paste {
                display: flex;
            }

            .twelve-reader-controller__paste-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                border-bottom: 1px solid var(--cd-border);
                flex-shrink: 0;
            }

            .twelve-reader-controller__paste-label {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.1em;
                text-transform: uppercase;
                color: var(--cd-muted);
            }

            .twelve-reader-controller__paste-body {
                display: flex;
                flex-direction: column;
                padding: 14px 16px 16px;
                gap: 8px;
            }

            .twelve-reader-controller__paste-textarea {
                padding: 12px 14px;
                border: 1px solid rgba(17, 24, 39, 0.12);
                border-radius: 14px;
                background: var(--cd-field);
                color: var(--cd-text);
                font: 14px/1.6 var(--cd-serif);
                resize: vertical;
            }

            .twelve-reader-controller__paste-actions {
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 8px;
            }

            .twelve-reader-controller__paste-read,
            .twelve-reader-controller__paste-clear {
                appearance: none;
                min-height: 44px;
                border-radius: 14px;
                padding: 0 18px;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.14em;
                text-transform: uppercase;
                cursor: pointer;
                transition: background 160ms ease;
            }

            .twelve-reader-controller__paste-read {
                border: 0;
                background: var(--cd-accent);
                color: #ffffff;
            }

            .twelve-reader-controller__paste-read:hover {
                background: var(--cd-accent-strong);
            }

            .twelve-reader-controller__paste-clear {
                border: 1px solid var(--cd-field-border);
                background: var(--cd-field);
                color: var(--cd-text);
            }

            .twelve-reader-controller__pill {
                display: none;
                align-items: center;
                gap: 12px;
                height: 56px;
                padding: 0 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.98);
                border: 1px solid var(--cd-border);
                box-shadow: var(--cd-shadow-pill);
            }

            #${CONTROLLER_ID}[data-mode="collapsed"] {
                background: transparent;
                border: 0;
                box-shadow: none;
                width: auto;
                max-height: none;
                overflow: visible;
            }

            #${CONTROLLER_ID}[data-mode="collapsed"] .twelve-reader-controller__header,
            #${CONTROLLER_ID}[data-mode="collapsed"] .twelve-reader-controller__body,
            #${CONTROLLER_ID}[data-mode="collapsed"] .twelve-reader-controller__paste {
                display: none;
            }

            #${CONTROLLER_ID}[data-mode="collapsed"] .twelve-reader-controller__pill {
                display: flex;
            }

            .twelve-reader-controller__pill-ring {
                --cd-ring: 0%;
                position: relative;
                width: 40px;
                height: 40px;
                border-radius: 999px;
                flex-shrink: 0;
                background: conic-gradient(var(--cd-accent) 0 var(--cd-ring), rgba(17, 17, 17, 0.10) var(--cd-ring) 100%);
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }

            .twelve-reader-controller__pill-toggle {
                appearance: none;
                width: 32px;
                height: 32px;
                border: 0;
                border-radius: 999px;
                background: var(--cd-ink);
                color: #ffffff;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }

            .twelve-reader-controller__pill-toggle svg {
                width: 16px;
                height: 16px;
            }

            .twelve-reader-controller__pill-label {
                flex: 1;
                min-width: 0;
                font-size: 12px;
                font-weight: 700;
                font-variant-numeric: tabular-nums;
                color: var(--cd-text);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            @media (prefers-reduced-motion: reduce) {
                #${CONTROLLER_ID} * {
                    transition: none !important;
                    animation: none !important;
                }
            }

            #${TOAST_ID} {
                position: fixed;
                right: 20px;
                bottom: 160px;
                max-width: 320px;
                padding: 10px 14px;
                border-radius: 999px;
                background: rgba(17, 24, 39, 0.92);
                color: #ffffff;
                font: 500 13px/1.4 Arial, sans-serif;
                box-shadow: 0 18px 45px rgba(15, 23, 42, 0.28);
                z-index: 2147483647;
                opacity: 0;
                transform: translateY(10px);
                transition: opacity 180ms ease, transform 180ms ease;
                pointer-events: none;
            }

            #${TOAST_ID}[data-visible="true"] {
                opacity: 1;
                transform: translateY(0);
            }

            html[data-twelve-reader-click-mode] {
                cursor: crosshair;
            }
        `;

        document.documentElement.appendChild(style);
    }

    let toastTimeoutId = null;
    function showToast(message) {
        let toast = document.getElementById(TOAST_ID);
        if (!toast) {
            toast = document.createElement("div");
            toast.id = TOAST_ID;
            toast.setAttribute("aria-live", "polite");
            document.documentElement.appendChild(toast);
        }

        toast.textContent = message;
        toast.dataset.visible = "true";
        if (toastTimeoutId) {
            window.clearTimeout(toastTimeoutId);
        }
        toastTimeoutId = window.setTimeout(() => {
            toast.dataset.visible = "false";
        }, 1800);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
})();
