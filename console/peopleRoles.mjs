// The roles People offers: each a name for one set of the three switches a member has (members.mjs and
// hostedMembers.mjs keep the switches, and everything else still asks about them). Picking a role sets all three;
// reading one names the switches a member has, so a list from before roles reads as roles too. Behind a hosting proxy
// Owner is the program's owner role and every other role its member role. Every member has My Woodshed's private
// sessions, whatever their role: `privateSessions` says so in People's table, and is no switch.

export const ROLES = [
  {
    id: 'owner', privateSessions: true, label: 'Owner', admin: true, githubSessions: true, assignable: true,
    explain: 'Opens these settings pages, starts sessions from GitHub and can be assigned shared sessions',
  },
  {
    id: 'member', privateSessions: true, label: 'Member', admin: false, githubSessions: true, assignable: true,
    explain: 'Starts sessions from GitHub (the label, /woodshed), sees Everyone, and can be assigned shared sessions',
  },
  {
    id: 'contributor', privateSessions: true, label: 'Contributor', admin: false, githubSessions: true, assignable: false,
    explain: 'Starts sessions from GitHub and sees Everyone, but is never assigned a shared session',
  },
  {
    id: 'private', privateSessions: true, label: 'Private only', admin: false, githubSessions: false, assignable: false,
    explain: 'Their own My Woodshed sessions only: no label, /woodshed, Everyone or shared sessions',
  },
];

const BY_ID = new Map(ROLES.map((r) => [r.id, r]));

/** @returns {object|null}  the role of that id */
export function roleById(id) {
  return BY_ID.get(id) ?? null;
}

/** @returns {string}  the role a member's switches make: an admin is an Owner whatever else they have */
export function roleOf(member) {
  if (member.admin) return 'owner';
  if (member.githubSessions && member.assignable) return 'member';
  if (member.githubSessions) return 'contributor';
  return 'private';
}

/**
 * @returns {string|null}  what a member's switches give, said in words, when they are not quite their role's: an owner
 *   kept from before roles with a switch off. Null when the role's own explanation says it.
 */
export function roleDiffers(member) {
  const role = BY_ID.get(roleOf(member));
  if (Boolean(member.githubSessions) === role.githubSessions && Boolean(member.assignable) === role.assignable) return null;
  return [
    'Opens these settings pages',
    member.githubSessions ? 'starts sessions from GitHub' : 'no sessions from GitHub',
    member.assignable ? 'can be assigned shared sessions' : 'never assigned a shared session',
  ].join(', ');
}
