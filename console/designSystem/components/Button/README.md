Buttons are small and square-ish (`radius-sm`, 12.5px `button`). Use one filled button per view.

- **Primary** (`action` fill, `action-ink` text): the one action that changes something. New session, Resume, Take it, Assign.
- **Outline** (`line` border, `ink` text): everything else that acts. Change, Clear, Unassign, Cancel.
- **Quiet** (no border, `amber-ink` text): a low-priority action beside a primary one. Remove.
- The consumer provides the label (a verb) and the click handler. On a card, the handler must stop the click from also opening the session.
- Do not use orange for a link, a warning or a status.
- A button whose action has a key the form reads itself (Start on New session: `⌘↵`, `Ctrl` `Enter` elsewhere) shows
  it after its label as caps (`.btn-keys`): outlined in the label's color at 75%, 8px after the words. Hidden where
  there is no hover (a phone, which has no keys). The button carries `data-keys` too, for the key hint.
