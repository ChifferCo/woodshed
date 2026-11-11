---
description: Turn on Remote Control without leaving claude. Signs this session in with your Claude account, then reopens this conversation with Remote Control on
allowed-tools: Bash(woodshed-login:*)
---

The person wants Remote Control in this Woodshed session. Remote Control needs a full Claude login, which the session's
own token is not, so `woodshed-login` signs in here. Its first step ran already, and printed this:

!`woodshed-login start`

Now:

1. If it says the session is already signed in, tell the person in one line that claude types `/remote-control` as
   soon as this reply ends, then end your turn. Do nothing else.
2. If it printed a link, show it to the person as a link, and ask them to open it, approve, and paste the code it
   shows here. Then end your turn and wait for the code. Say nothing else.
3. When they paste the code, run `woodshed-login code '<the code>'`, with nothing else in the command.
   - If it says the sign-in worked, tell the person in one line that claude reopens this conversation in a few seconds
     with Remote Control on, and end your turn at once: claude restarts only when your turn has ended.
   - If it says the code was not accepted, say so in one line and run `woodshed-login start` again for a new link.
4. If it printed an error, show it to the person in one line and stop.
