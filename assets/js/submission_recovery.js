/**
 * EzTyping — Submission Recovery Script
 * 
 * Loaded on every page (deferred). Checks localStorage for failed test/keystroke
 * submissions and retries them automatically in the background.
 * 
 * Security: Only submits to same-origin endpoints. Validates payload shape before sending.
 * Performance: ~2KB, runs once on page load, no intervals.
 */
(function () {
    'use strict';

    var QUEUE_KEY = 'ez_submission_queue';
    var BASE = (window.BASE_URL || '');

    function getQueue() {
        try {
            return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        } catch (e) { return []; }
    }

    function saveQueue(queue) {
        try {
            localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
        } catch (e) { /* ignore */ }
    }

    function removeFromQueue(index) {
        var queue = getQueue();
        queue.splice(index, 1);
        saveQueue(queue);
    }

    function showToast(message, isSuccess) {
        var toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
            'padding:12px 24px;border-radius:12px;font-size:14px;font-weight:600;z-index:99999;' +
            'box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity 0.5s;' +
            (isSuccess
                ? 'background:#059669;color:white;'
                : 'background:#d97706;color:white;');
        document.body.appendChild(toast);
        setTimeout(function () {
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 600);
        }, 5000);
    }

    // Validate payload shape to prevent sending garbage data
    function isValidTestPayload(p) {
        return p && p.test_id && p.category_id && p.raw_user_text && p.time_taken_ms > 0;
    }

    function isValidKeystrokePayload(p) {
        return p && p.result_id && p.category_id && p.keystroke_data;
    }

    function processQueue() {
        var queue = getQueue();
        if (queue.length === 0) return;

        // Discard entries older than 24 hours (stale data)
        var now = new Date().getTime();
        var validQueue = [];
        for (var i = 0; i < queue.length; i++) {
            var queuedTime = new Date(queue[i].queuedAt).getTime();
            if (now - queuedTime < 86400000) { // 24 hours
                validQueue.push(queue[i]);
            }
        }
        if (validQueue.length !== queue.length) {
            saveQueue(validQueue);
        }
        if (validQueue.length === 0) return;

        // Process one entry at a time (oldest first)
        var entry = validQueue[0];
        var url, valid;

        // Use the explicit URL stored in the queue if available, otherwise fallback
        if (entry.url) {
            url = entry.url;
            valid = (entry.type === 'test' || entry.type === 'hindi_test') ? isValidTestPayload(entry.payload) : isValidKeystrokePayload(entry.payload);
        } else {
            if (entry.type === 'test') {
                url = BASE + '/submit_test.php';
                valid = isValidTestPayload(entry.payload);
            } else if (entry.type === 'keystroke') {
                url = BASE + '/submit_keystrokes.php';
                valid = isValidKeystrokePayload(entry.payload);
            } else if (entry.type === 'hindi_test') {
                url = BASE + '/hindisubmit_test.php';
                valid = isValidTestPayload(entry.payload);
            } else if (entry.type === 'hindi_keystroke') {
                url = BASE + '/hindikeystrokes_submit.php';
                valid = isValidKeystrokePayload(entry.payload);
            } else {
                // Unknown type — discard
                removeFromQueue(0);
                return;
            }
        }

        if (!valid) {
            removeFromQueue(0);
            return;
        }

        var fetchOptions = {
            method: 'POST'
        };

        if (entry.type === 'keystroke' || entry.type === 'hindi_keystroke'
            || entry.type === 'test' || entry.type === 'hindi_test') {
            var formData = new FormData();
            var blob = new Blob([JSON.stringify(entry.payload)], { type: 'application/json' });
            formData.append('payload_file', blob, 'payload.json');
            fetchOptions.body = formData;
            // Fetch automatically sets the correct multipart/form-data boundary header when body is FormData
        } else {
            fetchOptions.headers = { 'Content-Type': 'application/json' };
            fetchOptions.body = JSON.stringify(entry.payload);
        }

        fetch(url, fetchOptions).then(function (res) {
            if (res.ok) {
                return res.json().then(function (data) {
                    if (data.status === 'success' || entry.type === 'keystroke') {
                        removeFromQueue(0);
                        if (entry.type === 'test') {
                            showToast('✅ Your previously saved test was submitted successfully!', true);
                        }
                        // Process next entry
                        setTimeout(processQueue, 1000);
                    } else if (data.message && (data.message.includes('not logged in') || data.message.includes('session'))) {
                        // User not logged in — can't retry, keep in queue for later
                        console.warn('Recovery: User not logged in, keeping in queue');
                    } else {
                        // Server-side validation error — discard (data is invalid)
                        removeFromQueue(0);
                    }
                });
            } else if (res.status >= 500 || res.status === 403) {
                // Server error or WAF block (403) — keep in queue for next page load
                console.warn('Recovery: Server/WAF error ' + res.status + ', will retry later');
            } else {
                // Client error (400/401/404) — discard
                removeFromQueue(0);
            }
        }).catch(function () {
            // Network error — keep in queue for next page load
            console.warn('Recovery: Network error, will retry on next page load');
        });
    }

    // Run after page is fully loaded to avoid competing with page resources
    if (document.readyState === 'complete') {
        setTimeout(processQueue, 2000);
    } else {
        window.addEventListener('load', function () {
            setTimeout(processQueue, 2000);
        });
    }
})();
