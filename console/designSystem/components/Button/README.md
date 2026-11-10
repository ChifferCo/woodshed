Buttons are small and square-ish (`radius-sm`, 12.5px `button`). Use one filled button per view.

- **Primary** (`action` fill, `action-ink` text): the one action that changes something. New session, Resume, Take it, Assign.
- **Outline** (`line` border, `ink` text): everything else that acts. Change, Clear, Unassign, Cancel.
- **Quiet** (no border, `amber-ink` text): a low-priority action beside a primary one. Remove.
- The consumer provides the label (a verb) and the click handler. On a card, the handler must stop the click from also opening the session.
- Do not use orange for a link, a warning or a status.
