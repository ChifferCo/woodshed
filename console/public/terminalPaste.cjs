// Files and Ctrl+V on a terminal: what terminal.js does with a paste, a drop or Ctrl+V, kept apart from the page so its
// test drives it with a stand-in xterm, clipboard and upload. One file for terminal.js (a script that sets
// `WoodshedTerminalPaste`) and its test.
//
// A file goes through the console to the session's statusd, which saves it under /tmp/uploads and types its path at the
// pane's prompt in tmux. An agent in Herdr cannot be typed into without an Enter, so statusd answers `typed: false`
// there and the paths go in from here, as a paste on the terminal's own connection, as the person's ⌘V would.
(function (root, factory) {
  const paste = factory();
  if (typeof module === 'object' && module.exports) module.exports = paste;
  else root.WoodshedTerminalPaste = paste;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const MAX_FILES = 8;
  const MAX_FILE_MB = 25;
  const MAX_TOTAL_MB = 40;
  const MB = 1024 * 1024;
  // What a clipboard item holds besides a file: read as text, never uploaded.
  const TEXT_TYPES = new Set(['text/plain', 'text/html', 'text/uri-list']);

  /** A pasted screenshot has no name; its type gives it one. */
  function fileName(file) {
    return file.name || `pasted.${(String(file.type).split('/')[1] || 'png').replace(/[^a-z0-9]/g, '')}`;
  }

  /** Whether the terminal takes input now: xterm's stdin is off while its connection is down (terminalPage.js). */
  function canType(term) {
    return Boolean(term) && !term.options?.disableStdin;
  }

  /**
   * Each file uploaded, and the paths statusd could not type pasted at the prompt with no Enter. Paths already saved
   * still go in when a later file fails, and are named when the terminal cannot take them.
   * @param {{name?: string, size: number, type: string}[]} files
   * @param {{upload: (file: object, name: string) => Promise<{ok: boolean, body: any}>,
   *   term?: {paste: (text: string) => void, focus?: () => void, options?: object}|null, toast: (text: string) => void}} io
   * @returns {Promise<{typed: number, pasted: string[], failed: boolean}>}
   */
  async function attachFiles(files, { upload, term, toast }) {
    const none = { typed: 0, pasted: [], failed: true };
    if (files.length > MAX_FILES) return toast(`At most ${MAX_FILES} files at a time`), none;
    const big = files.find((f) => f.size > MAX_FILE_MB * MB);
    if (big) return toast(`${big.name || 'That file'} is over ${MAX_FILE_MB} MB`), none;
    if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_MB * MB) return toast(`Those add up to more than ${MAX_TOTAL_MB} MB`), none;
    toast(files.length === 1 ? `Attaching ${files[0].name || 'the file'}…` : `Attaching ${files.length} files…`);
    let typed = 0;
    const untyped = [];
    let error = null;
    for (const file of files) {
      const res = await upload(file, fileName(file)).catch(() => null);
      if (!res?.ok) {
        error = res?.body?.error ? `Not attached: ${res.body.error}` : 'Attach failed';
        break;
      }
      // A statusd from before `typed` typed it whenever it could.
      if (res.body?.typed === false && typeof res.body.path === 'string') untyped.push(res.body.path);
      else typed++;
    }
    let pasted = [];
    let missed = '';
    if (untyped.length) {
      if (canType(term)) {
        term.paste(`${untyped.join(' ')} `);
        term.focus?.();
        pasted = untyped;
        typed += untyped.length;
      } else {
        missed = `Saved in the session as ${untyped.join(' ')}: type ${untyped.length === 1 ? 'its path' : 'their paths'} at the prompt`;
      }
    }
    const done = typed ? `${typed} path${typed === 1 ? '' : 's'} typed at the prompt` : '';
    if (error) toast([error, done && `${done} before it`, missed].filter(Boolean).join('. '));
    else if (missed) toast(missed);
    else toast(`${done}: add your question and press enter`);
    return { typed, pasted, failed: Boolean(error) };
  }

  /**
   * What Ctrl+V does in a terminal frame: null for a key that is not Ctrl+V, or in the Terminal tab's shell, which keeps
   * ^V. Otherwise the key is kept from xterm (which would send ^V, to an agent whose own clipboard, the session's, holds
   * nothing), and then: `native`, the browser's own paste follows, as for Ctrl+Shift+V; `clipboard`, on a Mac, where
   * Ctrl+V is no paste of the browser's, the page reads the clipboard; `repeat`, a held key, which pastes once.
   * @returns {null|'native'|'clipboard'|'repeat'}
   */
  function ctrlV(e, { mac, pane }) {
    if (pane === 'terminal') return null;
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'v') return null;
    if (!mac) return 'native';
    return e.repeat ? 'repeat' : 'clipboard';
  }

  /**
   * The clipboard as a paste would bring it: its pictures and files, else its text. The browser asks the person first
   * (or offers its Paste button).
   * @param {{read?: () => Promise<any[]>, readText?: () => Promise<string>}|undefined} clip  navigator.clipboard
   * @param {typeof File} FileCtor  the frame's File
   * @returns {Promise<{files: object[]}|{text: string}|null>}  null when it may not be read, or holds nothing
   */
  async function readClipboard(clip, FileCtor) {
    try {
      if (clip?.read) {
        const files = [];
        let text = '';
        for (const item of await clip.read()) {
          const type = item.types.find((t) => t.startsWith('image/')) || item.types.find((t) => !TEXT_TYPES.has(t));
          if (type) files.push(new FileCtor([await item.getType(type)], '', { type }));
          else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
        }
        if (files.length) return { files };
        return text ? { text } : null;
      }
      const text = await clip?.readText();
      return text ? { text } : null;
    } catch {
      return null;
    }
  }

  /**
   * What the clipboard held, into the terminal: its files attached, its text pasted, and with nothing the browser would
   * hand over, the key as the agent's own ^V.
   */
  function pasteClipboard(got, { term, attach }) {
    if (got?.files) return attach(got.files);
    if (!term) return undefined;
    if (got?.text) return term.paste(got.text);
    return term.input('\x16');
  }

  /**
   * Everything above, on one terminal frame's document: a paste or drop of files, and Ctrl+V in an agent's pane.
   * @param {Document} doc  the frame's, whose window holds `term` (xterm), `navigator.clipboard` and `File`
   * @param {{pane: string, mac: boolean, upload: (file: object, name: string) => Promise<{ok: boolean, body: any}>,
   *   toast: (text: string) => void}} opts
   */
  function bind(doc, { pane, mac, upload, toast }) {
    const win = doc.defaultView;
    const attach = (files) => attachFiles(files, { upload, term: win?.term, toast });
    const take = (e, list) => {
      const files = [...(list || [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      attach(files);
    };
    doc.addEventListener('paste', (e) => take(e, e.clipboardData?.files), true);
    doc.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }, true);
    doc.addEventListener('drop', (e) => take(e, e.dataTransfer?.files), true);
    doc.addEventListener('keydown', (e) => {
      const how = ctrlV(e, { mac, pane });
      if (!how) return;
      // Kept from xterm, which would send ^V. `native`: the browser's own paste follows, and the listener above or
      // xterm's takes it.
      e.stopImmediatePropagation();
      if (how === 'native') return;
      e.preventDefault();
      if (how === 'repeat') return;
      readClipboard(win?.navigator?.clipboard, win?.File).then((got) => pasteClipboard(got, { term: win?.term, attach }));
    }, true);
  }

  return { bind, attachFiles, ctrlV, readClipboard, pasteClipboard, fileName, MAX_FILES, MAX_FILE_MB, MAX_TOTAL_MB };
});
