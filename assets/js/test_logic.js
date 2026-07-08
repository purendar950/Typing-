document.addEventListener('DOMContentLoaded', function () {
    // --- 1. Get All Elements (Robust Selection) ---

    // Select ALL potential test areas to read dataset from ANY of them
    const testAreas = [
        document.getElementById('test-area'),
        document.getElementById('test-area-tcs'),
        document.getElementById('test-area-nta'),
        document.getElementById('test-area-paper')
    ].filter(el => el !== null);

    // We need at least one to get dataset settings. 
    // If multiple exist (which shouldn't happen with unique IDs, but effectively might in legacy), 
    // we assume they share the same settings.
    const testArea = testAreas[0];
    if (!testArea) return; // Exit if not on a test page

    // Select ALL potential user inputs
    const userInputs = [
        document.getElementById('userInput'),
        document.getElementById('userInput-tcs'),
        document.getElementById('userInput-nta'),
        document.getElementById('userInput-paper')
    ].filter(el => el !== null);

    // SECURITY: Prevent Paste
    userInputs.forEach(input => {
        input.addEventListener('paste', function (e) {
            e.preventDefault();
            console.warn('Pasting is disabled for security reasons.');
            // Optional: Show a toast or alert
        });
    });

    // Select ALL potential control button wrappers
    const mainControlButtonsList = document.querySelectorAll('#mainControlButtons, .main-control-buttons');

    const testIdField = document.getElementById('testId');
    const categoryIdField = document.getElementById('categoryId');

    // UI-specific elements (they might be null)
    const liveCountElement = document.getElementById('liveCount');
    const backspaceToggleBtn = document.getElementById('backspace-toggle-btn');

    // Track the active input (the one the user is typing in)
    let activeInput = userInputs[0] || null;

    // --- Fix Download Link ---
    const downloadLink = document.querySelector('a[href*="generate_pdf.php"]');
    if (downloadLink && testIdField && testIdField.value) {
        downloadLink.href = `/generate_pdf.php?id=${testIdField.value}`;
    }

    // --- 2. Read Dynamic Rules from HTML (Set by PHP) ---
    const timeLimitInMinutes = parseFloat(testArea.dataset.timeLimitMinutes) || 10;
    const backspaceRule = testArea.dataset.backspaceRule; // 'allowed', 'disabled', 'current_word', 'last_two_words'
    const disableCtrl = testArea.dataset.disableCtrl === '1';
    const disableArrowKeys = testArea.dataset.disableArrowKeys === '1';

    let timerInterval;
    let startTime;
    let testStarted = false;
    let isBackspaceDisabled = (backspaceRule === 'disabled');
    const totalTimeInSeconds = timeLimitInMinutes * 60;

    // Forward-only locking boundary for 'last_two_words'
    let maxLockedIndex = -1;

    // --- Advanced Analytics ---
    let keystrokeLog = [];
    const ignoredKeys = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'Enter'];

    // --- RELIABILITY: localStorage Auto-Save (crash/close protection) ---
    const _lsTestKey = 'ez_pending_test_' + (testIdField ? testIdField.value : '0');
    let _autoSaveInterval = null;

    function _saveToLocalStorage() {
        try {
            if (!testStarted || !activeInput) return;
            const payload = {
                testId: testIdField ? testIdField.value : '',
                categoryId: categoryIdField ? categoryIdField.value : '',
                rawUserText: activeInput.value,
                timeTakenMs: startTime ? (new Date().getTime() - startTime) : 0,
                keystrokeLog: keystrokeLog,
                savedAt: new Date().toISOString()
            };
            localStorage.setItem(_lsTestKey, JSON.stringify(payload));
        } catch (e) {
            // localStorage unavailable (private browsing, quota) — silently ignore
        }
    }

    function _clearLocalStorage() {
        try { localStorage.removeItem(_lsTestKey); } catch (e) { /* ignore */ }
    }

    // --- RELIABILITY: Fetch with Exponential Backoff Retry ---
    async function _fetchWithRetry(url, options, maxRetries, statusCallback) {
        // Retryable HTTP status codes (server-side transient errors)
        const RETRYABLE_HTTP = [500, 502, 503, 504, 429, 0];
        let lastError = null;
        let lastResponse = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                // Exponential backoff with random jitter: 2s, 4s, 8s, 16s + random 1-3s
                const baseDelay = Math.min(2000 * Math.pow(2, attempt - 1), 16000);
                const delay = baseDelay + (Math.floor(Math.random() * 2000) + 1000);
                if (statusCallback) statusCallback(attempt, maxRetries, delay);
                await new Promise(r => setTimeout(r, delay));
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s per attempt

            try {
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(timeoutId);

                // Firewall Block Handling - immediate exit
                if (response.status === 403) {
                    throw Object.assign(new Error('Forbidden'), { status: 403 });
                }

                if (RETRYABLE_HTTP.includes(response.status)) {
                    lastError = Object.assign(new Error('Server error ' + response.status), { status: response.status });
                    continue; // Retry on server overload
                }

                // VALIDATION: Check if the response body is valid JSON before returning.
                // On flaky broadband/mobile, responses can be truncated or corrupted
                // (e.g. PHP warnings prepended to JSON). If body is not valid JSON
                // and we still have retries left, retry instead of returning garbage.
                if (response.ok) {
                    try {
                        const text = await response.text();
                        JSON.parse(text); // Validate — throws if non-JSON
                        // Valid JSON — create a new Response with the text we already consumed
                        const validResponse = new Response(text, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                        return validResponse;
                    } catch (jsonErr) {
                        console.warn('Attempt ' + attempt + ': Server returned non-JSON response, retrying...');
                        lastError = new Error('Non-JSON response from server');
                        if (attempt < maxRetries) continue; // Retry if we have attempts left
                        // On last attempt, return the original response so caller can handle it
                        return response;
                    }
                }

                return response; // Client error (400/401) — don't retry
            } catch (err) {
                clearTimeout(timeoutId);
                lastError = err;

                if (err.name === 'AbortError') {
                    // Timeout — retry
                    continue;
                }
                if (err.message && err.message.includes('Failed to fetch')) {
                    // Network offline — retry
                    continue;
                }
                // Unknown error — don't retry
                throw err;
            }
        }
        // All retries exhausted
        throw lastError || new Error('All retry attempts failed');
    }

    // --- RELIABILITY: Offline Queue for Failed Submissions ---
    function _addToOfflineQueue(payload, type, targetUrl) {
        try {
            const queue = JSON.parse(localStorage.getItem('ez_submission_queue') || '[]');
            // Limit queue to 10 entries to prevent storage abuse
            if (queue.length >= 10) queue.shift();
            queue.push({ type: type, payload: payload, url: targetUrl, queuedAt: new Date().toISOString() });
            localStorage.setItem('ez_submission_queue', JSON.stringify(queue));
        } catch (e) { /* localStorage unavailable */ }
    }

    // --- Helper function to get all timer elements dynamically ---
    // This is called every second to ensure we always update visible timers
    function getAllTimerElements() {
        return [
            document.getElementById('timer'),
            document.getElementById('timer-tcs'),
            document.getElementById('timer-nta'),
            document.getElementById('timer-paper')
        ].filter(el => el !== null);
    }

    // --- 3. UI and Timer Logic ---
    function startTest() {
        if (testStarted) return;
        testStarted = true;

        console.log("Test Started: Timer set for " + timeLimitInMinutes + " minutes.");

        // Show ALL found control button wrappers
        mainControlButtonsList.forEach(el => el.style.display = 'flex');

        startTime = new Date().getTime();

        // Calculate the absolute end time based on current time + limit
        // This prevents "drift" where setInterval runs slower than real time
        const durationMs = timeLimitInMinutes * 60 * 1000;
        const endTime = startTime + durationMs;

        // Use a 1-second interval to update UI, but calculate remaining time from Date.now()
        timerInterval = setInterval(function () {
            const now = new Date().getTime();
            const msRemaining = endTime - now;

            // Round up to nearest second for display
            // Math.ceil ensures we see "10:00" at start and "00:01" right before end
            let timeRemainingSeconds = Math.ceil(msRemaining / 1000);

            // Prevent negative display
            if (timeRemainingSeconds < 0) timeRemainingSeconds = 0;

            const minutes = Math.floor(timeRemainingSeconds / 60);
            const seconds = timeRemainingSeconds % 60;
            const timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

            // Re-query timer elements EVERY SECOND to handle dynamic layouts
            const currentTimerElements = getAllTimerElements();
            currentTimerElements.forEach(el => {
                el.textContent = timeString;
                // Red color warning for last 5 minutes (300 seconds)
                if (timeRemainingSeconds <= 300) {
                    el.style.color = 'red';
                } else {
                    el.style.color = ''; // Reset
                }
            });

            // If we have passed the end time, stop
            if (msRemaining <= 0) {
                clearInterval(timerInterval);
                finishTest();
            }
        }, 1000);

        // Add focus-trapping
        document.addEventListener('click', handlePageClick);

        // RELIABILITY: Auto-save typed text to localStorage every 5 seconds
        _autoSaveInterval = setInterval(_saveToLocalStorage, 5000);

        // RELIABILITY: Network Keep-Alive Ping (prevents home router NAT tables from dropping idle connection during 15m test)
        // AND keeps the PHP session alive (prevents "User not logged in" errors on long tests).
        setInterval(() => {
            const pingUrl = (window.BASE_URL || '') + '/ping.php';
            fetch(pingUrl, { cache: 'no-store' }).catch(() => {});
        }, 120000); // Background ping every 2 minutes

        // Auto-Start if configured (e.g. Live Tests)
        if (testArea.dataset.autostart === 'true') {
            startTest();
        }
    }

    function handlePageClick(e) {
        // Check if target is ANY of the user inputs
        const isInput = userInputs.includes(e.target);

        // Also allow interaction with buttons, links, selects, and their children
        const isInteractive = e.target.closest('button, a, select, input, textarea, [role="button"]');

        if (testStarted && !isInput && !isInteractive) {
            // Find visible input to focus if clicked outside
            if (activeInput && activeInput.offsetParent !== null) {
                e.preventDefault();
                activeInput.focus();
            }
        }
    }

    // --- 4. Advanced Key Restriction Logic (Attached to ALL Inputs) ---
    function getCurrentWord(text, cursorPosition) {
        const textBeforeCursor = text.substring(0, cursorPosition);
        const lastSpace = textBeforeCursor.lastIndexOf(' ');
        return textBeforeCursor.substring(lastSpace + 1);
    }

    // Attach listeners to ALL discovered inputs
    userInputs.forEach(userInput => {



        userInput.addEventListener('keydown', function (e) {
            // Update active input reference
            activeInput = this;

            // --- DYNAMIC RULE CHECK (Fix for Settings Modal Toggle) ---
            const currentBackspaceRule = testArea.dataset.backspaceRule;
            const isBSDisabled = (currentBackspaceRule === 'disabled');

            if (disableCtrl && e.ctrlKey && !e.altKey) {
                if (e.key !== '4' && e.key !== '$' && e.key !== '₹' && e.key !== 'Control') {
                    e.preventDefault();
                }
            }
            if (e.key === 'Tab') e.preventDefault();

            if (e.key === 'Delete') {
                if (isBSDisabled) {
                    e.preventDefault();
                } else if (currentBackspaceRule === 'last_two_words') {
                    if (maxLockedIndex >= 0 && userInput.selectionStart <= maxLockedIndex) {
                        e.preventDefault();
                    }
                }
                return; // Allow if backspace enabled and not blocked by rules
            }

            // ALWAYS Block these navigation keys
            if (['Home', 'End', 'Insert', 'PageUp', 'PageDown'].includes(e.key)) {
                e.preventDefault();
                return;
            }

            // Disable arrow keys ONLY if configured
            if (disableArrowKeys && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                return;
            }

            const cursorPosition = userInput.selectionStart;

            if (e.key === 'Backspace') {
                if (isBSDisabled) {
                    e.preventDefault();
                    return;
                }
                if (currentBackspaceRule === 'current_word') {
                    const currentWord = getCurrentWord(userInput.value, cursorPosition);
                    if (currentWord === "" && cursorPosition > 0) {
                        // At start of a word (after a space), prevent deleting the space
                        e.preventDefault();
                    }
                }
                if (currentBackspaceRule === 'last_two_words') {
                    const isSelection = userInput.selectionStart !== userInput.selectionEnd;
                    const bound = isSelection ? maxLockedIndex : maxLockedIndex + 1;
                    if (maxLockedIndex >= 0 && userInput.selectionStart <= bound) {
                        e.preventDefault();
                    }
                }
            }

            // Any non-backspace key presses
            if (e.key.length === 1) {
                if (currentBackspaceRule === 'current_word') {
                    const currentWord = getCurrentWord(userInput.value, cursorPosition);
                    if (e.key === ' ' && currentWord === "") {
                        // Prevent typing multiple spaces
                        e.preventDefault();
                    }
                }
                if (currentBackspaceRule === 'last_two_words') {
                    if (maxLockedIndex >= 0 && cursorPosition <= maxLockedIndex) {
                        e.preventDefault();
                    }
                }
            }

            // --- Log Keystroke ---
            if (!ignoredKeys.includes(e.key) && testStarted) {
                keystrokeLog.push({
                    k: e.key,
                    t: new Date().getTime() - startTime
                });
            }
        });

        userInput.addEventListener('input', function () {
            activeInput = this;
            if (!testStarted) {
                startTest();
            }

            const currentBackspaceRule = testArea.dataset.backspaceRule;
            if (currentBackspaceRule === 'last_two_words') {
                const text = userInput.value;
                let spaces = [];
                for (let i = 0; i < text.length; i++) {
                    if (text[i] === ' ') spaces.push(i);
                }
                if (spaces.length >= 2) {
                    maxLockedIndex = Math.max(maxLockedIndex, spaces[spaces.length - 2]);
                }
            }

            if (liveCountElement) {
                const charCount = userInput.value.length;
                const wordCount = Math.floor(charCount / 5);
                liveCountElement.textContent = `Chars: ${charCount}, Words: ${wordCount}`;
            }
        });
    });

    // --- 5. Submit Logic ---

    // Attach submit listener to ALL submit buttons found
    const submitButtons = document.querySelectorAll('#submitTest, #submitTestMobile');
    submitButtons.forEach(btn => {
        btn.addEventListener('click', finishTest);
    });

    // Attach cancel listener
    const cancelButtons = document.querySelectorAll('#cancelTest');
    cancelButtons.forEach(btn => {
        btn.addEventListener('click', function () {
            if (confirm("Are you sure you want to cancel the test?")) {
                window.location.reload();
            }
        });
    });

    async function finishTest() {
        if (!testStarted) return;
        testStarted = false;

        mainControlButtonsList.forEach(el => el.style.display = 'none');
        clearInterval(timerInterval);
        // Stop auto-save interval
        if (_autoSaveInterval) { clearInterval(_autoSaveInterval); _autoSaveInterval = null; }

        // Final save to localStorage before submission attempt
        _saveToLocalStorage();

        // Disable all inputs
        userInputs.forEach(input => input.disabled = true);

        document.removeEventListener('click', handlePageClick);

        // Show a loading state
        const overlay = document.getElementById('submit-overlay');
        let testWrapper = null;
        // Reference for retry status text inside overlay
        let _statusEl = null;

        if (overlay) {
            overlay.classList.add('active');
            // Add a status line if not present
            _statusEl = overlay.querySelector('.submit-status');
            if (!_statusEl) {
                _statusEl = document.createElement('p');
                _statusEl.className = 'submit-status';
                _statusEl.style.cssText = 'margin-top:12px;font-size:14px;color:#6b7280;';
                overlay.appendChild(_statusEl);
            }
            _statusEl.textContent = 'Submitting your test...';
        } else {
            testWrapper = document.getElementById('test-wrapper') || document.getElementById('test-area') || document.getElementById('main-content-wrapper') || testAreas[0];
            if (testWrapper) {
                testWrapper.innerHTML = '<div class="w-full bg-white p-8 text-center text-xl font-semibold">Calculating results... Please wait.<p class="submit-status" style="margin-top:12px;font-size:14px;color:#6b7280;">Submitting your test...</p></div>';
                _statusEl = testWrapper.querySelector('.submit-status');
            }
        }

        // Helper function to enable retry
        const enableRetry = () => {
            testStarted = true;
            userInputs.forEach(input => input.disabled = false);
            mainControlButtonsList.forEach(el => el.style.display = 'flex');
            if (overlay) overlay.classList.remove('active');
        };

        // Helper for compression
        async function compressAndEncode(text) {
            if (typeof CompressionStream !== 'undefined') {
                try {
                    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
                    const buffer = await new Response(stream).arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                    }
                    return { data: btoa(binary), isGzipped: true, isBase64: false };
                } catch(e) {
                    // Fallback
                }
            }
            return { data: btoa(unescape(encodeURIComponent(text))), isGzipped: false, isBase64: true };
        }

        // STEP 1: Create the raw data packet (WITHOUT keystroke data for reliability)
        let userText = activeInput ? activeInput.value : '';
        let isEncoded = false;
        let isGzipped = false;

        // Compress and encode to bypass WAF and reduce size
        try {
            const res = await compressAndEncode(userText);
            userText = res.data;
            if (res.isGzipped) isGzipped = true;
            if (res.isBase64) isEncoded = true;
        } catch (e) {
            console.warn("Text encoding failed, sending raw data:", e);
        }

        // Clamp Time Taken to Limit
        let actualTimeTaken = new Date().getTime() - startTime;
        const maxTimeMs = timeLimitInMinutes * 60 * 1000;
        if (actualTimeTaken > maxTimeMs) {
            actualTimeTaken = maxTimeMs;
        }

        const rawDataForServer = {
            test_id: testIdField.value,
            category_id: categoryIdField.value,
            raw_user_text: userText,
            is_base64_encoded: isEncoded,
            is_gzipped: isGzipped,
            time_taken_ms: actualTimeTaken
        };

        // Determine submit URL
        const isLiveTest = window.location.pathname.includes('live_test_main') || window.location.pathname.includes('live-tests');
        let submitURL = window.SUBMIT_URL;
        if (!submitURL) {
            submitURL = isLiveTest
                ? (window.BASE_URL ? window.BASE_URL + '/live_test_submit.php' : '/live_test_submit.php')
                : (window.BASE_URL ? window.BASE_URL + '/submit_test.php' : '/submit_test.php');
        }

        // ADDED: Expanded random jitter (delay) between 0 and 8000ms
        // This prevents server resource exhaustion when multiple students submit simultaneously.
        const jitterMs = Math.floor(Math.random() * 8000);
        await new Promise(resolve => setTimeout(resolve, jitterMs));

        try {
            const formData = new FormData();
            const blob = new Blob([JSON.stringify(rawDataForServer)], { type: 'application/json' });
            formData.append('payload_file', blob, 'payload.json');

            // --- RETRY-ENABLED SUBMISSION (4 retries with exponential backoff) ---
            const response = await _fetchWithRetry(
                submitURL,
                {
                    method: 'POST',
                    body: formData
                },
                4, // max retries
                (attempt, maxRetries, delay) => {
                    // Update UI with retry status
                    const msg = `Submitting your test, please wait...`;
                    console.warn(msg);
                    if (_statusEl) _statusEl.textContent = msg;
                }
            );

            // Parse response
            const responseText = await response.text();
            let data;
            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Server returned non-JSON response:', responseText.substring(0, 500));
                let errorMsg = 'Server error occurred.';
                if (responseText.includes('User not logged in')) {
                    errorMsg = 'Your session has expired. Please refresh the page and login again.';
                } else if (response.status === 403) {
                    errorMsg = `Submission blocked (Error 403).\nIf you are using a VPN or strict school/office WiFi, please disable it or securely connect via Mobile Data.`;
                } else if (!response.ok) {
                    errorMsg = `Server error (${response.status}). Please try again.`;
                }
                alert(errorMsg + '\n\nYour typed text is safely preserved. Please try submitting again.');
                enableRetry();
                return;
            }

            if (data.status === 'success') {
                // SUCCESS — clear localStorage backup
                _clearLocalStorage();

                // STEP 2: Submit keystroke data with retries (3 attempts)
                if (keystrokeLog.length > 0 && data.result_id) {
                    let encodedKeystrokes = JSON.stringify(keystrokeLog);
                    let isKsEncoded = false;
                    let isKsGzipped = false;
                    try {
                        const ksRes = await compressAndEncode(encodedKeystrokes);
                        encodedKeystrokes = ksRes.data;
                        if (ksRes.isGzipped) isKsGzipped = true;
                        if (ksRes.isBase64) isKsEncoded = true;
                    } catch (e) {
                         console.warn("Keystroke encoding failed, falling back to raw data:", e);
                    }

                    const keystrokePayload = {
                        result_id: data.result_id,
                        category_id: categoryIdField.value,
                        keystroke_data: encodedKeystrokes,
                        is_base64_encoded: isKsEncoded,
                        is_gzipped: isKsGzipped
                    };
                    const keystrokeURL = window.BASE_URL ? window.BASE_URL + '/submit_keystrokes.php' : '/submit_keystrokes.php';

                    const ksFormData = new FormData();
                    const ksBlob = new Blob([JSON.stringify(keystrokePayload)], { type: 'application/json' });
                    ksFormData.append('payload_file', ksBlob, 'payload.json');

                    // Retry keystroke upload in background (don't block redirect)
                    _fetchWithRetry(
                        keystrokeURL,
                        {
                            method: 'POST',
                            body: ksFormData
                        },
                        3, // max retries
                        null // no UI updates for background upload
                    ).then(res => {
                        console.log('Keystroke data submitted:', res.ok ? 'success' : 'failed');
                    }).catch(err => {
                        console.warn('Keystroke retry exhausted, queuing for recovery:', err.message);
                        _addToOfflineQueue(keystrokePayload, 'keystroke', keystrokeURL);
                    });
                }

                // Redirect to result page immediately
                if (data.redirect_url) {
                    window.location.href = data.redirect_url;
                } else if (isLiveTest) {
                    window.location.href = `/live_test_result.php?id=${data.result_id}`;
                } else {
                    const baseUrl = window.BASE_URL || '';
                    const catId = categoryIdField ? categoryIdField.value : 0;
                    window.location.href = `${baseUrl}/result/${data.result_id}/${catId}`;
                }
            } else {
                // Server returned error (auth, validation, etc.)
                let errorMsg = data.message || 'Failed to save result';
                if (errorMsg.includes('not logged in') || errorMsg.includes('session')) {
                    errorMsg = 'Your session has expired. Please refresh and login again.';
                }
                alert(`Error: ${errorMsg}\n\nYour typed text is preserved. Please try again.`);
                enableRetry();
            }
        } catch (error) {
            // ALL retries exhausted — save to offline queue for later recovery
            console.error('All submission attempts failed:', error.name, error.message);
            _addToOfflineQueue(rawDataForServer, 'test', submitURL);

            if (_statusEl) {
                _statusEl.textContent = 'Your data is safely saved offline. It will be submitted when connection is restored.';
                _statusEl.style.color = '#d97706';
            }

            // Show accurate alert with error status
            let errorStatusText = 'Could not reach the server after multiple attempts.';
            if (error.status === 403) {
                errorStatusText = 'Submission blocked by firewall (Error 403). Ensure VPNs are disabled.';
            } else if (error.status) {
                errorStatusText = `Server busy (Error ${error.status}).`;
            } else if (error.name === 'AbortError') {
                errorStatusText = 'Request timed out. The server or network is busy.';
            } else if (error.message && error.message.includes('Failed to fetch')) {
                errorStatusText = 'Network error. Please check your internet connection.';
            }

            setTimeout(() => {
                alert(
                    `${errorStatusText}\n\n` +
                    '✅ Your typed text is safely saved on this device.\n' +
                    '✅ It will be automatically submitted when you visit any page on this site.\n\n' +
                    'Please try submitting again or try on a different network.'
                );
                enableRetry();
            }, 500);

            if (testWrapper && !overlay) {
                testWrapper.innerHTML = `<div class="w-full bg-white p-8 text-center text-amber-600">Your data is saved offline and will be submitted automatically.<br><button onclick="location.reload()" class="mt-4 px-4 py-2 bg-blue-500 text-white rounded">Try Again Now</button></div>`;
            }
        }
    }

    // --- 6. Display Logic ---
    function displayResults(results) {
        const resultsContainer = document.getElementById('resultsContainer');
        const resultContent = document.getElementById('result-content');

        if (!resultsContainer || !resultContent) {
            console.error("Result container or content not found. Check HTML structure.");
            return;
        }

        // --- Determine Status Styles ---
        let isPassed = false;
        let statusColor = 'bg-gray-100 text-gray-800 border-gray-200';
        let statusIcon = 'fa-chart-bar';
        let heroGradient = 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';
        const qStatus = results.qualificationStatus;

        if (qStatus === 'Qualified' || qStatus === 'Pass') {
            isPassed = true;
            statusColor = 'bg-green-100 text-green-800 border-green-200';
            statusIcon = 'fa-check-circle';
            heroGradient = 'linear-gradient(135deg, #059669 0%, #047857 100%)';
        } else if (qStatus) {
            statusColor = 'bg-red-100 text-red-800 border-red-200';
            statusIcon = 'fa-times-circle';
            heroGradient = 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)';
        }

        // --- Build Metrics HTML ---
        // Speed
        const speedVal = results.typingspeed ?? results.netWPM ?? '0';
        const grossVal = results.grossWPM ?? '-';

        // Accuracy
        const accVal = results.accuracy ?? 0;

        // Modules (Marks or Time)
        let fourthCardHtml = '';
        if (results.marksAwarded !== null && results.marksAwarded !== undefined) {
            fourthCardHtml = `
            <div class="rounded-xl p-6 shadow-sm border bg-white border-gray-200 transition-transform hover:-translate-y-1">
                <div class="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">Marks Scored</div>
                <div class="flex items-end">
                    <span class="text-4xl font-bold text-indigo-500">${results.marksAwarded}</span>
                    <span class="text-lg font-medium text-gray-400 ml-1 mb-1">/ 50</span>
                </div>
                 <div class="mt-2 text-sm text-gray-500">
                     Typed: ${results.totalWordsTyped || 0} Words
                 </div>
            </div>`;
        } else {
            fourthCardHtml = `
            <div class="rounded-xl p-6 shadow-sm border bg-white border-gray-200 transition-transform hover:-translate-y-1">
                <div class="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">Time Taken</div>
                <div class="flex items-end">
                    <span class="text-4xl font-bold text-gray-800">${results.timeTaken || 0}</span>
                    <span class="text-lg font-medium text-gray-400 ml-1 mb-1">min</span>
                </div>
                 <div class="mt-2 text-sm text-gray-500">
                     Typed: ${results.totalWordsTyped || 0} Words
                 </div>
            </div>`;
        }

        // Error Breakdown
        const errors = [
            { label: 'Spelling', k: 'spelling', c: 'bg-red-100 text-red-700' },
            { label: 'Skipped', k: 'omission', c: 'bg-cyan-100 text-cyan-700' },
            { label: 'Extra Word', k: 'extra', c: 'bg-pink-100 text-pink-700' },
            { label: 'Spacing', k: 'spacing', c: 'bg-orange-100 text-orange-700' },
            { label: 'Capitalization', k: 'capitalization', c: 'bg-yellow-100 text-yellow-700' },
            { label: 'Punctuation', k: 'punctuation', c: 'bg-purple-100 text-purple-700' },
        ];

        let errorListHtml = '';
        let hasErrors = false;
        errors.forEach(e => {
            const count = results.errorCounts[e.k] || 0;
            if (count > 0) {
                hasErrors = true;
                errorListHtml += `
                <div class="flex justify-between items-center p-2 rounded-lg hover:bg-gray-50">
                    <span class="text-sm font-medium text-gray-700">${e.label}</span>
                    <span class="px-2 py-0.5 rounded text-xs font-bold ${e.c}">${count}</span>
                </div>`;
            }
        });
        if (!hasErrors) {
            errorListHtml = '<div class="text-center text-gray-400 italic py-4">Perfect typing! No errors found.</div>';
        }

        const allowedMistakesHtml = (results.FinalcountofMistake !== null && results.totalMistakes !== null)
            ? `<div class="flex justify-between items-center mb-2"><span class="text-sm text-gray-500">Allowed Errors</span><span class="font-bold text-gray-700">${(Math.abs(results.totalMistakes - results.FinalcountofMistake)).toFixed(2)}</span></div>`
            : '';

        const finalMistakesHtml = (results.FinalcountofMistake !== null)
            ? `<div class="flex justify-between items-center"><span class="text-sm font-bold text-red-500">Final Errors</span><span class="font-bold text-xl text-red-600">${results.FinalcountofMistake}</span></div>`
            : '';


        // --- Detailed Matrix Table ---
        const matrixTableHtml = `
            <div class="rounded-xl shadow-sm border bg-white border-gray-200 p-6 mb-8">
                <h3 class="text-lg font-bold mb-4 flex items-center text-gray-800">
                    <i class="fas fa-table text-blue-500 mr-2"></i> Detailed Performance Matrix
                </h3>
                <div class="overflow-x-auto">
                    <table class="w-full text-sm text-left border-collapse">
                        <thead>
                            <tr class="bg-gray-50 text-gray-700 uppercase">
                                <th class="p-3 border border-gray-200">Metric</th>
                                <th class="p-3 border border-gray-200">Value</th>
                                <th class="p-3 border border-gray-200">Metric</th>
                                <th class="p-3 border border-gray-200">Value</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                            <tr>
                                <td class="p-3 border border-gray-100 font-medium">Net Speed</td>
                                <td class="p-3 border border-gray-100 font-bold text-green-600 text-lg">${speedVal} WPM</td>
                                <td class="p-3 border border-gray-100 font-medium">Gross Speed</td>
                                <td class="p-3 border border-gray-100 font-bold text-gray-800">${grossVal} WPM</td>
                            </tr>
                            <tr>
                                <td class="p-3 border border-gray-100 font-medium">Accuracy</td>
                                <td class="p-3 border border-gray-100 font-bold text-blue-600">${accVal}%</td>
                                <td class="p-3 border border-gray-100 font-medium">Total Words Typed</td>
                                <td class="p-3 border border-gray-100">${results.totalWordsTyped || 0}</td>
                            </tr>
                            <tr>
                                <td class="p-3 border border-gray-100 font-medium">Time Taken</td>
                                <td class="p-3 border border-gray-100">${results.timeTaken || 0} min</td>
                                <td class="p-3 border border-gray-100 font-medium">Marks Awarded</td>
                                <td class="p-3 border border-gray-100 font-bold text-indigo-600">${results.marksAwarded !== null ? results.marksAwarded : '-'}</td>
                            </tr>
                            <tr>
                                <td class="p-3 border border-gray-100 font-medium">Full Mistakes</td>
                                <td class="p-3 border border-gray-100 text-red-500">${results.fullMistakes || 0}</td>
                                <td class="p-3 border border-gray-100 font-medium">Half Mistakes</td>
                                <td class="p-3 border border-gray-100 text-orange-500">${results.halfMistakes || 0}</td>
                            </tr>
                            <tr>
                                <td class="p-3 border border-gray-100 font-medium">Total Mistakes</td>
                                <td class="p-3 border border-gray-100 font-bold text-red-600">${results.totalMistakes || 0}</td>
                                <td class="p-3 border border-gray-100 font-medium">Allowed Mistakes</td>
                                <td class="p-3 border border-gray-100">${(results.FinalcountofMistake !== null && results.totalMistakes !== null) ? (Math.abs(results.totalMistakes - results.FinalcountofMistake)).toFixed(2) : '-'}</td>
                            </tr>
                             <tr>
                                <td class="p-3 border border-gray-100 font-medium">Final Penalty Errors</td>
                                <td class="p-3 border border-gray-100 font-bold text-red-700">${results.FinalcountofMistake !== null ? results.FinalcountofMistake : '-'}</td>
                                <td class="p-3 border border-gray-100 font-medium">Result Status</td>
                                <td class="p-3 border border-gray-100 font-bold ${qStatus === 'Qualified' || qStatus === 'Pass' ? 'text-green-600' : 'text-red-600'}">${qStatus || 'Completed'}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>`;

        const content = `
            <!-- Hero Header -->
            <div class="rounded-2xl shadow-lg relative overflow-hidden mb-8 text-center py-10 text-white" style="background: ${heroGradient};">
                 <div class="absolute inset-0 opacity-10" style="background-image: radial-gradient(#ffffff 1px, transparent 1px); background-size: 20px 20px;"></div>
                 <div class="relative z-10">
                    <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm mb-4">
                        <i class="fas ${statusIcon} text-3xl"></i>
                    </div>
                    <h1 class="text-4xl md:text-5xl font-extrabold tracking-tight mb-2">
                        ${qStatus || 'Completed'}
                    </h1>
                    <p class="text-white/80 text-lg font-medium">Test Completed Successfully</p>
                 </div>
            </div>

            <!-- Metrics Grid -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <!-- Speed -->
                <div class="rounded-xl p-6 shadow-sm border bg-white border-gray-200 transition-transform hover:-translate-y-1">
                    <div class="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">Net Speed</div>
                    <div class="flex items-end">
                        <span class="text-4xl font-bold text-gray-800">${speedVal}</span>
                        <span class="text-lg font-medium text-gray-400 ml-1 mb-1">WPM</span>
                    </div>
                    <div class="mt-2 text-sm text-green-500 font-medium">Gross: ${grossVal} WPM</div>
                </div>

                <!-- Accuracy -->
                <div class="rounded-xl p-6 shadow-sm border bg-white border-gray-200 transition-transform hover:-translate-y-1">
                    <div class="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">Accuracy</div>
                    <div class="flex items-end">
                        <span class="text-4xl font-bold text-gray-800">${accVal}</span>
                        <span class="text-lg font-medium text-gray-400 ml-1 mb-1">%</span>
                    </div>
                    <div class="mt-2 w-full bg-gray-200 rounded-full h-1.5">
                        <div class="bg-blue-600 h-1.5 rounded-full" style="width: ${Math.min(100, parseFloat(accVal))}%"></div>
                    </div>
                </div>

                <!-- Mistakes -->
                <div class="rounded-xl p-6 shadow-sm border bg-white border-gray-200 transition-transform hover:-translate-y-1">
                     <div class="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-1">Total Errors</div>
                     <div class="flex items-end">
                        <span class="text-4xl font-bold text-red-500">${results.totalMistakes || 0}</span>
                    </div>
                    <div class="mt-2 text-sm text-gray-500">
                        Full: ${results.fullMistakes || 0} | Half: ${results.halfMistakes || 0}
                    </div>
                </div>

                <!-- Time / Marks -->
                ${fourthCardHtml}
            </div>

            <!-- Detailed Matrix Table (RESTORED) -->
            ${matrixTableHtml}

            <!-- Detailed Grid (Error Breakdown & Comparison) -->
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- Left: Errors -->
                <div class="lg:col-span-1 rounded-xl shadow-sm border bg-white border-gray-200 p-6">
                    <h3 class="text-lg font-bold mb-4 flex items-center text-gray-800">
                        <i class="fas fa-exclamation-triangle text-amber-500 mr-2"></i> Error Breakdown
                    </h3>
                    <div class="space-y-3">
                        ${errorListHtml}
                    </div>
                </div>

                <!-- Right: Comparison -->
                <div class="lg:col-span-2 rounded-xl shadow-sm border bg-white border-gray-200 p-6 flex flex-col h-[500px]">
                     <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-bold text-gray-800">
                            <i class="fas fa-file-alt text-indigo-500 mr-2"></i> Comparative Review
                        </h3>
                        <div class="text-xs text-gray-400 flex gap-2">
                            <span class="flex items-center"><span class="w-2 h-2 rounded-full bg-red-400 mr-1"></span> Wrong</span>
                            <span class="flex items-center"><span class="w-2 h-2 rounded-full bg-green-400 mr-1"></span> Correct</span>
                        </div>
                    </div>
                    <div class="flex-grow grid grid-cols-1 md:grid-cols-2 gap-4 overflow-hidden">
                        <div class="flex flex-col h-full">
                            <span class="text-xs uppercase font-bold text-gray-400 mb-2">Original Text</span>
                            <div class="flex-grow overflow-auto p-4 rounded-lg border border-gray-200 bg-gray-50 text-base leading-relaxed font-mono text-gray-600">
                                ${results.highlightedOriginalText}
                            </div>
                        </div>
                        <div class="flex flex-col h-full">
                             <span class="text-xs uppercase font-bold text-gray-400 mb-2">Your Input</span>
                            <div class="flex-grow overflow-auto p-4 rounded-lg border border-gray-200 bg-gray-50 text-base leading-relaxed font-mono text-gray-800">
                                ${results.highlightedUserText}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Buttons -->
            <div class="mt-8 flex justify-center gap-4">
                <a href="${window.BASE_URL}/my_results/" class="px-6 py-3 rounded-xl font-bold transition-all border shadow-sm hover:shadow-md flex items-center bg-white text-gray-700 border-gray-300">
                    <i class="fas fa-list-ul mr-2 text-gray-400"></i> My History
                </a>
                <a href="${window.BASE_URL}/category_list/" class="px-8 py-3 rounded-xl font-bold transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5 text-white flex items-center bg-gradient-to-r from-blue-600 to-indigo-600">
                    Try Another Test <i class="fas fa-arrow-right ml-2"></i>
                </a>
            </div>
        `;

        resultContent.innerHTML = content;
        resultsContainer.style.display = 'block';
    }
});