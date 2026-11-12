// Dictation into a text field, with the browser's speech recognition: the phone's message box (messageBox.js) and New
// session's prompt (launcher.js). Settled words go into the field after what was there; words still settling are
// handed to `heard` to show beside it, and kept in the field when it stops.
(function () {
  'use strict';
  const W = window.Woodshed;
  // Safari's, Chrome's and Edge's. Safari sends the audio to Apple to turn it into text, as its keyboard's mic does;
  // Chrome and Edge send it to Google and Microsoft. Firefox has none, so its mic stays hidden.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  const MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

  /**
   * Listens until stopped, writing into `field`.
   * @param {HTMLTextAreaElement} field
   * @param {{heard?: (pending: string) => void, changed?: () => void, ended?: () => void}} hooks
   *   heard: the words still settling ('' once none); changed: the field's value moved; ended: it stopped by itself or
   *   after stop(), not after abort()
   * @returns {{stop: () => void, abort: () => string}|null}  null when it could not start. stop() lets its last words
   *   settle; abort() cuts off at once and returns the words still settling, for a caller that keeps them itself.
   */
  function dictate(field, { heard = () => {}, changed = () => {}, ended = () => {} } = {}) {
    if (!Recognition) return null;
    const base = field.value ? `${field.value.replace(/\s*$/, '')} ` : '';
    const recognition = new Recognition();
    // Its events count only while it is still the one listening.
    let live = true;
    let pending = '';
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      if (!live) return;
      let settled = '';
      pending = '';
      for (const result of e.results) {
        if (result.isFinal) settled += result[0].transcript;
        else pending += result[0].transcript;
      }
      field.value = base + settled.trimStart();
      heard(pending);
      changed();
    };
    recognition.onerror = (e) => {
      if (!live) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') W.shell.toast('The microphone is not allowed for this site: allow it in the browser\'s settings');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') W.shell.toast(`Dictation stopped: ${e.error}`);
    };
    // Words still settling when it stops are kept: a recogniser need not settle them before it ends.
    recognition.onend = () => {
      if (!live) return;
      live = false;
      if (pending.trim()) {
        field.value = `${field.value.replace(/\s*$/, '')} ${pending.trim()}`.trimStart();
        changed();
      }
      pending = '';
      heard('');
      ended();
    };
    try {
      recognition.start();
    } catch (err) {
      W.shell.toast(`Dictation did not start: ${err.message}`);
      return null;
    }
    return {
      stop: () => recognition.stop(),
      abort() {
        if (!live) return '';
        live = false;
        const words = pending.trim();
        pending = '';
        heard('');
        recognition.abort();
        return words;
      },
    };
  }

  W.dictation = { available: Boolean(Recognition), dictate, MIC_ICON };
})();
