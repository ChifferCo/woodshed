// The state behind the "ask about this" panels on the review page.
//
// It lives in its own module, and is shipped to the browser the same way
// `tokenizeLine` is — `${createAskState.toString()}` interpolated into
// page.mjs's one inline script — so that it can be unit tested. It must
// therefore be SELF-CONTAINED: a reference to any module-scope binding parses
// fine here and throws ReferenceError in the browser. `askState.test.mjs`
// rebuilds it with `new Function` to prove that, with a negative control.
//
// WHY IT EXISTS AT ALL, since a Map and two variables would look like enough:
//
// The review page rebuilds its whole document on every render — the artifact
// arriving reorders the file cards, so there is no incremental update to make —
// and the ask panel is the one piece of that document a user can be mid-sentence
// in. Four separate bugs shipped from keeping the panel's state in loose
// mutable variables that each render re-derived:
//
//   1. Answers lived only in the DOM, so a rebuild lost them.
//   2. Drafts hung off the "currently open" object, which is nulled on close,
//      so closing and reopening a panel lost what had been typed.
//   3. The draft was stashed at render time and keyed off that same "currently
//      open" variable — which the open/close handlers had ALREADY reassigned by
//      then, so a draft typed at file A was filed under file B's key and then
//      shown as B's.
//   4. Focus was applied by the panel's own render, so every unrelated rebuild
//      (expanding a different file, a 2-second poll) stole the caret back and
//      scrolled the viewport to it.
//
// Every one of those is the same mistake: state whose lifetime is longer than a
// render, derived from a variable whose lifetime is shorter. So the model here
// is deliberately dull:
//
//   * everything is keyed by ANCHOR — a stable string naming the place asked
//     about — and never by "the panel that happens to be open";
//   * a draft is written when the user types, not collected at render time;
//   * an answer is keyed by (anchor, question), so editing the question hides
//     an answer that no longer matches it and retyping brings it back;
//   * focus is a one-shot REQUEST that the opener makes and the renderer
//     consumes, not something a render does because a panel exists.

/**
 * @returns an ask-panel state object. One per page.
 */
export function createAskState() {
  // anchor -> the text currently in that panel's input.
  var drafts = {};
  // anchor -> {question: {text, costUsd, steps, durationMs, ...}}
  var answers = {};
  // anchor -> the error from the last failed ask, cleared on the next ask.
  var errors = {};
  // anchor -> true while a run is in flight.
  var busy = {};
  // anchor -> the conversation so far: [{role: 'user'|'assistant', text, ...}].
  var threads = {};
  var openAnchor = null;
  var focusWanted = null;

  // A question is used as an object key, so it needs a prefix that cannot
  // collide with anything inherited from Object.prototype — '' would otherwise
  // look up `constructor` and friends for a user who asks the right question.
  function qkey(question) {
    return 'q:' + String(question == null ? '' : question);
  }

  function has(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  return {
    /**
     * The stable name of a place that can be asked about.
     *
     * `side` is part of it because it is part of the question: for a modified
     * line the deleted and added rows carry the SAME number, so without it the
     * two halves of one line share a panel, a draft and an answer.
     */
    anchorKey: function anchorKey(path, line, side) {
      if (line === null || line === undefined || line === '') return String(path) + '|file';
      return String(path) + '|' + (side === 'old' ? 'o' : 'n') + String(line);
    },

    /** Open a panel and ask for the caret. The only thing that ever does. */
    open: function open(anchor) {
      openAnchor = anchor;
      focusWanted = anchor;
    },

    close: function close() {
      openAnchor = null;
      focusWanted = null;
    },

    /**
     * Open it if it is shut, shut it if it is open.
     * @returns true when the panel ended up open.
     */
    toggle: function toggle(anchor) {
      if (openAnchor === anchor) {
        openAnchor = null;
        focusWanted = null;
        return false;
      }
      openAnchor = anchor;
      focusWanted = anchor;
      return true;
    },

    openAnchor: function currentlyOpen() {
      return openAnchor;
    },

    isOpen: function isOpen(anchor) {
      return openAnchor === anchor;
    },

    /**
     * Consume the focus request, if it is for this anchor.
     *
     * One-shot: the second call returns false. That is the whole defence
     * against a rebuild triggered by something else — a poll, another file
     * being expanded — putting the caret back in a box the user has left.
     */
    takeFocus: function takeFocus(anchor) {
      if (focusWanted !== anchor) return false;
      focusWanted = null;
      return true;
    },

    draft: function draft(anchor) {
      return has(drafts, anchor) ? drafts[anchor] : '';
    },

    /** Called as the user types, so the stored draft is never out of date. */
    setDraft: function setDraft(anchor, text) {
      drafts[anchor] = String(text == null ? '' : text);
    },

    /**
     * The answer for this anchor AND this exact question, or null.
     *
     * Matching on the question is what makes an edited question hide an answer
     * that no longer belongs to it — and what makes retyping the original
     * bring that answer straight back rather than re-running it.
     */
    answer: function answer(anchor, question) {
      if (!has(answers, anchor)) return null;
      var forAnchor = answers[anchor];
      var key = qkey(question);
      return has(forAnchor, key) ? forAnchor[key] : null;
    },

    setAnswer: function setAnswer(anchor, question, value) {
      if (!has(answers, anchor)) answers[anchor] = {};
      answers[anchor][qkey(question)] = value;
      delete errors[anchor];
    },

    /** The conversation at this anchor, oldest first. A copy, so callers cannot edit it. */
    thread: function thread(anchor) {
      return has(threads, anchor) ? threads[anchor].slice() : [];
    },

    /** Record one answered exchange. Only called once the answer is in, so a failed ask leaves no half turn. */
    addTurn: function addTurn(anchor, question, answer) {
      if (!has(threads, anchor)) threads[anchor] = [];
      threads[anchor].push({ role: 'user', text: String(question) });
      var turn = { role: 'assistant', text: String(answer && answer.text != null ? answer.text : '') };
      if (answer && answer.steps) turn.steps = answer.steps;
      if (answer && answer.durationMs) turn.durationMs = answer.durationMs;
      if (answer && typeof answer.costUsd === 'number') turn.costUsd = answer.costUsd;
      threads[anchor].push(turn);
      delete errors[anchor];
    },

    error: function error(anchor) {
      return has(errors, anchor) ? errors[anchor] : null;
    },

    setError: function setError(anchor, message) {
      errors[anchor] = String(message == null ? '' : message);
    },

    isBusy: function isBusy(anchor) {
      return !!busy[anchor];
    },

    setBusy: function setBusy(anchor, value) {
      if (value) {
        busy[anchor] = true;
        delete errors[anchor];
      } else {
        delete busy[anchor];
      }
    },
  };
}
