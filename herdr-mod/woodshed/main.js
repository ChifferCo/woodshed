// Woodshed: your Woodshed sessions beside your terminals. A panel lists them with when each pauses, and starts new
// ones; an agent that needs you in a session's machine is named by its session. Everything here calls the `woodshed` command line, which holds the sign-in: this mod never
// sees a token.
//
// One mod, three views, picked by props().view:
//   (none)     the panel (docked, or as a dialog with `mod.open woodshed`)
//   "new"      New Woodshed session…: a form, then the start step by step
//   "info"     Session info: when it pauses or stops, with Extend
//
// A start runs as a herdr-core terminal of its own, named woodshed-new-…, so it outlives the dialog and the window;
// the mod reads its output with `hc read`.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  exec, hc, home, theme, props, run, openOverlay, closeOverlay, notify, agents, spaces, focused,
  checking, nextCommand,
} from "herdr";
import {
  EXIT, SESSION_ID, sessionOfMachine, terminalName, newSessionArgs, startProgress, outcomeOf,
  pauseText, mayExtend, newlyBlocked, blockedNotice,
} from "./woodshed.js";
import {
  readPanel, tidyStarts, startRefusal, startInTerminal, pollStart, readSession, extendSession,
} from "./actions.js";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const LIVE = new Set(["queued", "starting", "running", "stopping"]);

// The command line's path, found once through the person's shell: herdr-core runs a background terminal's program
// directly, with the core's PATH, which may not have it.
let cliPath = null;
async function cli() {
  if (cliPath) return cliPath;
  const r = await exec("sh", ["-c", "command -v woodshed"]).catch(() => null);
  const found = r?.code === 0 ? r.stdout.trim().split("\n")[0] : "";
  if (!found) throw new Error("the woodshed command line is not installed: see herdr-mod/README.md");
  cliPath = found;
  return cliPath;
}

/** The command line, run and waited for. Never rejects: a command that could not start comes back as code 1. */
async function runCli(args, timeout = 60_000) {
  try {
    return await exec(await cli(), args, { cwd: home(), timeout });
  } catch (err) {
    return { code: EXIT.failed, stdout: "", stderr: err?.message ?? String(err) };
  }
}

/** hc, run and waited for. Never rejects. */
async function runCore(args) {
  return hc(args).catch((err) => ({ code: 1, stdout: "", stderr: err?.message ?? String(err) }));
}

/** Starts the command line in a background herdr-core terminal of its own. @returns {Promise<string|null>} an error */
async function launch(name, args) {
  let path;
  try {
    path = await cli();
  } catch (err) {
    return err.message;
  }
  return startInTerminal(runCore, { path, name, cwd: home(), args });
}

// The system's browser, through the app (it takes only http and https URLs with a host).
function openUrl(cx, url) {
  if (/^https?:\/\/[^/\s]+/.test(String(url ?? ""))) cx.open_url(url);
}

/** The session whose space has the keyboard, when it is on a Woodshed session's machine. */
function focusedSession() {
  const space = spaces().find((s) => s.id === focused()?.space);
  return sessionOfMachine(space?.machine);
}

function dialog(view, extra = {}) {
  const width = view === "new" ? 520 : 480;
  openOverlay({ mod: "woodshed", kind: "dialog", width, props: { view, ...extra } });
}

export default class Woodshed extends View {
  init(_props, cx) {
    this.view = props()?.view ?? null;
    this.id = SESSION_ID.test(props()?.id ?? "") ? props().id : null;
    this.handle = cx.focus_handle();
    if (this.view === "new") this.initNew(cx);
    else if (this.view === "info") this.initInfo(cx);
    else this.initPanel(cx);
  }

  close() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape" && props()?.overlay) { this.close(); cx.stop_propagation(); }
  }

  // ---- The panel ----

  initPanel(cx) {
    this.who = null; // {console, login} | {signedOut: reason} | {missing: reason}
    this.sessions = null;
    this.listError = null;
    this.seen = new Map(); // agent address -> last status, for notifications
    this.finishedStarts = new Set(); // starts' terminals found finished at the last tidy
    this.watching = false;
    if (checking()) return;
    cx.spawn(async (cx) => { await this.refresh(); cx.notify(); });
    cx.timer.every(30_000, (cx) => cx.spawn(async (cx) => { await this.refresh(); cx.notify(); }));
    // Agents blocked in a session's machine: the app's live data, read every 2 s, no process started.
    cx.timer.every(2_000, () => {
      const fresh = newlyBlockedOnce(this);
      for (const n of fresh) notify(n);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.command(command, cx);
        cx.notify();
      }
    });
  }

  // Keys bound as "woodshed.<command>" in keys.json: new, and info (on the focused session's space).
  command(name, cx) {
    if (name === "new") return dialog("new");
    const id = focusedSession();
    if (!id) return notify({ title: "Not a Woodshed session", body: "Focus a space on a woodshed-<id> machine, or use the Woodshed panel.", level: "info" });
    if (name === "info") dialog("info", { id });
  }

  async refresh() {
    Object.assign(this, await readPanel(runCli));
    await tidyStarts(runCore, this.finishedStarts);
  }

  panelRow(t, s) {
    const now = Date.now();
    const dot = s.state === "needs-you" ? t.blocked : s.state === "working" ? t.working : LIVE.has(s.status) ? t.idle : t.dim;
    return v_flex().id(`ws-row-${s.id}`).px(8).py(6).gap(2).rounded(7).cursor_pointer().hover((st) => st.bg(t.hover))
      .on_click(() => dialog("info", { id: s.id }))
      .child(h_flex().gap(7).items_center()
        .child(s.status === "starting" || s.status === "queued"
          ? svg(I("spinner")).size(10).text_color(t.working).spin(900)
          : div().size(7).rounded(4).bg(dot))
        .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(t.foreground).child(s.title || s.id))
        .child(div().flex_none().text_size(11.5).text_color(s.state === "needs-you" ? t.blocked : t.dim).child(s.stateWord ?? "")))
      .child(h_flex().gap(6).items_center().pl(14)
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(s.id))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(pauseText(s.pause, now))));
  }

  renderPanel(t) {
    const who = this.who;
    const button = (id, text, primary, action) => div().id(id).h(26).px(10).flex().items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    const note = (text, color = t.dim) => div().px(8).py(6).text_size(12).line_height("17px").text_color(color).child(text);
    let body;
    if (!who) body = [note("Asking the woodshed command line…")];
    else if (who.missing) body = [note(who.missing, t.blocked)];
    else if (who.signedOut) {
      body = [note(`${who.signedOut[0].toUpperCase()}${who.signedOut.slice(1)}.`), h_flex().px(8).child(button("ws-login", "Sign in…", true, () => this.signIn()))];
    } else if (!this.sessions) body = [note(this.listError ?? "Reading your sessions…", this.listError ? t.blocked : t.dim)];
    else {
      const live = this.sessions.filter((s) => LIVE.has(s.status));
      const ended = this.sessions.length - live.length;
      body = [
        ...(live.length ? live.map((s) => this.panelRow(t, s)) : [note("No session running.")]),
        ...(ended ? [note(`${ended} stopped: woodshed session list`)] : []),
        ...(this.listError ? [note(this.listError, t.blocked)] : []),
      ];
    }
    return v_flex().id("woodshed").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(props()?.overlay ? t.popover : t.chrome).text_color(t.foreground)
      .child(h_flex().h(36).px(10).gap(8).items_center().flex_none()
        .child(div().flex_1().text_size(12.5).font_semibold().child("Woodshed"))
        .child(div().id("ws-refresh").px(4).py(3).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => { await this.refresh(); cx.notify(); }))
          .child(svg(I("clock")).size(13).text_color(t.muted)))
        .child(button("ws-new", "New session…", true, () => dialog("new"))))
      .when(Boolean(who?.login), (el) => el.child(div().px(10).pb(4).text_size(11.5).text_color(t.dim).truncate()
        .child(`@${who.login} on ${who.console}`)))
      .child(v_flex().id("ws-list").flex_1().min_h(0).overflow_y_scroll().px(4).gap(2).children(body));
  }

  async signIn() {
    try {
      run("tab.new", { name: "woodshed login", argv: [await cli(), "login"], folder: home() });
    } catch (err) {
      notify({ title: "Woodshed", body: err.message, level: "error" });
    }
  }

  // ---- New session ----

  initNew(cx) {
    this.fields = {};
    const hints = [
      ["repo", "owner/name (blank: your usual one)"],
      ["branch", "branch, or a pull request or issue number"],
      ["prompt", "What should it do? (blank on a branch or PR: it reviews it)"],
    ];
    for (const [key, placeholder] of hints) {
      const input = InputState.new({ placeholder });
      input.on("change", (_e, cx) => { this.fields[key] = input.value(); this.formError = null; cx.notify(); });
      input.on("submit", (_e, cx) => this.start(cx));
      this.fields[`${key}Input`] = input;
    }
    this.fields.agent = "claude";
    this.formError = null;
    this.fields.repoInput.focus();
    cx.timer.after(600, () => this.fields.repoInput.focus());
    this.started = null; // {name, progress, finished: {code}|null, error}
    cx.timer.every(1_000, (cx) => {
      const s = this.started;
      if (!s || s.finished || s.error || !s.launched || this.polling) return;
      this.polling = true;
      cx.spawn(async (cx) => {
        try {
          Object.assign(s, await pollStart(runCore, s.name));
          cx.notify();
        } finally {
          this.polling = false;
        }
      });
    });
  }

  start(cx) {
    if (this.started) return;
    this.formError = startRefusal(this.fields);
    if (this.formError) {
      cx.notify();
      return;
    }
    const s = { name: terminalName("new", Date.now().toString(36)), progress: startProgress(""), finished: null, error: null, launched: false };
    this.started = s;
    cx.notify();
    cx.spawn(async (cx) => {
      s.error = await launch(s.name, newSessionArgs(this.fields));
      s.launched = !s.error;
      cx.notify();
    });
  }

  // Back to the form, its fields as they were, after a start that did not run.
  editAgain() {
    this.started = null;
  }

  renderNew(t) {
    const f = this.fields;
    const label = (text) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const input = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    const choice = (value) => div().id(`ws-agent-${value}`).h(28).px(12).flex().items_center().rounded(7).cursor_pointer()
      .border_1().border_color(f.agent === value ? t.accent : t.input).bg(f.agent === value ? t.selected : t.raised)
      .text_size(12).on_click((_e, cx) => { f.agent = value; cx.notify(); }).child(value === "codex" ? "Codex" : "Claude Code");
    const s = this.started;
    const head = h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("New Woodshed session"))
      .child(div().id("ws-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().on_click(() => this.close()).child("Esc"));
    const root = v_flex().id("woodshed-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).child(head);
    if (!s) {
      return root
        .child(div().pt(6).text_size(12.5).line_height("18px").text_color(t.muted)
          .child("A private session on Woodshed, as New session on the console starts it: its own machine, branch and databases."))
        .child(label("Repository")).child(input(f.repoInput))
        .child(label("Branch")).child(input(f.branchInput))
        .child(label("Agent")).child(h_flex().gap(6).child(choice("claude")).child(choice("codex")))
        .child(label("Prompt")).child(input(f.promptInput))
        .when(Boolean(this.formError), (el) => el.child(div().pt(6).text_size(12).text_color(t.blocked).child(this.formError)))
        .child(h_flex().pt(18).gap(8).justify_end()
          .child(div().id("ws-cancel").h(32).px(14).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.raised)
            .text_size(12.5).cursor_pointer().on_click(() => this.close()).child("Cancel"))
          .child(div().id("ws-start").h(32).px(14).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground)
            .text_size(12.5).font_medium().cursor_pointer().on_click((_e, cx) => this.start(cx)).child("Start")));
    }
    const p = s.progress;
    const done = s.finished !== null;
    const outcome = done ? outcomeOf(s.finished.code) : null;
    const id = p.session?.id;
    const steps = p.steps.map((text, i) => h_flex().gap(8).items_center().text_size(12.5)
      .child(!done && i === p.steps.length - 1 ? svg(I("spinner")).size(12).text_color(t.working).spin(900) : svg(I("check")).size(12).text_color(t.ansi2))
      .child(div().text_color(t.foreground).child(text)));
    const ending = {
      running: `Session ${id} is running.`,
      "needs-you": `Session ${id} is running and needs you: open it on the console.`,
      failed: `Session ${id} failed to start${p.session?.error ? `: ${p.session.error}` : "."}`,
      stopped: `Session ${id} stopped before it ran.`,
    }[p.end];
    const message = s.error ?? (done ? (ending ?? p.error ?? outcome.word) : (p.status === "queued" ? `Session ${id} waits in line for a machine` : id ? `Starting session ${id}` : "Asking the console…"));
    return root
      .child(div().pt(8).text_size(12.5).text_color(s.error || outcome?.level === "error" ? t.blocked : t.muted).child(message))
      .child(v_flex().pt(10).gap(6).children(steps))
      .child(h_flex().pt(18).gap(8).justify_end()
        .when(Boolean(p.session?.url), (el) => el.child(div().id("ws-console").h(32).px(14).flex().items_center().rounded(8)
          .border_1().border_color(t.input).bg(t.raised).text_size(12.5).cursor_pointer().on_click((_e, cx) => openUrl(cx, p.session.url)).child("Open on the console")))
        .when(done && p.end === "running" && Boolean(id), (el) => el.child(div().id("ws-info").h(32).px(14).flex().items_center().rounded(8)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium().cursor_pointer()
          .on_click(() => { this.close(); dialog("info", { id }); }).child("Session info")))
        .when(Boolean(s.error) || (done && s.finished.code !== EXIT.done && s.finished.code !== EXIT.waiting), (el) => el.child(div().id("ws-again")
          .h(32).px(14).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.raised).text_size(12.5).cursor_pointer()
          .on_click((_e, cx) => { this.editAgain(); cx.notify(); }).child("Edit and try again")))
        .child(div().id("ws-close").h(32).px(14).flex().items_center().rounded(8).border_1().border_color(t.input).bg(t.raised)
          .text_size(12.5).cursor_pointer().on_click(() => this.close()).child(done || s.error ? "Close" : "Close, it keeps starting")));
  }

  // ---- Session info ----

  initInfo(cx) {
    this.session = null;
    this.infoError = null;
    this.extending = false;
    this.extendSaid = null;
    if (!this.id || checking()) return;
    cx.spawn(async (cx) => { await this.readSession(); cx.notify(); });
    // Read again while it is open, so Extend turns on when the last 15 minutes come.
    cx.timer.every(30_000, (cx) => cx.spawn(async (cx) => { if (!this.extending) { await this.readSession(); cx.notify(); } }));
  }

  async readSession() {
    const read = await readSession(runCli, this.id);
    if (read.session) {
      this.session = read.session;
      this.infoError = null;
    } else this.infoError = read.error;
  }

  extend(cx) {
    if (this.extending) return;
    this.extending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      this.extendSaid = await extendSession(runCli, this.id);
      await this.readSession();
      this.extending = false;
      cx.notify();
    });
  }

  renderInfo(t) {
    const s = this.session;
    const now = Date.now();
    const line = (label, value) => h_flex().gap(10).py(3).text_size(12.5)
      .child(div().w(90).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).text_color(t.foreground).child(value ?? ""));
    const button = (id, text, primary, enabled, action) => div().id(id).h(30).px(12).flex().items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(!enabled, (el) => el.opacity(0.4)).when(enabled, (el) => el.cursor_pointer().on_click(action)).child(text);
    const root = v_flex().id("woodshed-info").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(s?.title || `Session ${this.id}`))
        .child(div().id("ws-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().on_click(() => this.close()).child("Esc")));
    if (!s) return root.child(div().pt(10).text_size(12.5).text_color(this.infoError ? t.blocked : t.dim).child(this.infoError ?? "Reading the session…"));
    const pause = s.pause ? `${pauseText(s.pause, now)} (${new Date(s.pause.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : s.status === "running" ? "not yet: it is busy" : "not running";
    const runsOn = s.runsOn ? `${s.runsOn.idleHours} h idle, ${s.runsOn.lifetimeHours} h lifetime${s.ownLimits ? " (its own)" : ""}` : "";
    const canExtend = mayExtend(s, now) && !this.extending;
    const running = s.status === "running";
    return root
      .child(v_flex().pt(10)
        .child(line("Session", `${s.id} · ${s.stateWord}`))
        .child(line("Branch", s.branch))
        .when(Boolean(s.prUrl), (el) => el.child(line("Pull request", s.prUrl)))
        .child(line("Pauses", pause))
        .child(line("Runs on", runsOn)))
      .child(div().pt(8).text_size(12).line_height("17px").text_color(t.dim)
        .child(running ? (canExtend
          ? "Extend puts its pause or stop off by an hour."
          : "Extend opens in the last 15 minutes before it pauses or stops. A connection does not keep it awake.") : ""))
      .when(Boolean(this.extendSaid), (el) => el.child(div().pt(6).text_size(12).text_color(t.blocked).child(this.extendSaid)))
      .child(h_flex().pt(16).gap(8).justify_end().flex_wrap()
        .child(button("ws-console", "Open on the console", false, true, (_e, cx) => openUrl(cx, s.url)))
        .child(button("ws-extend", this.extending ? "Extending…" : "Extend", true, running && canExtend, (_e, cx) => this.extend(cx))));
  }

  render() {
    const t = theme();
    if (this.view === "new") return this.renderNew(t);
    if (this.view === "info") return this.renderInfo(t);
    return this.renderPanel(t);
  }
}

// The notifications for agents in a session's machine that have just become blocked. The first look only learns
// what is there: Herdr has already said so for anything blocked before the panel started.
function newlyBlockedOnce(panel) {
  const first = !panel.watching;
  panel.watching = true;
  const fresh = newlyBlocked(panel.seen, agents(), spaces());
  return first ? [] : fresh.map((b) => blockedNotice(b, panel.sessions));
}
