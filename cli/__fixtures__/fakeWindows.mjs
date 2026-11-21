// A stand-in for Windows PowerShell as the command line's credentials run it (credentials.mjs): DPAPI's seal and
// unseal, and the script that makes a folder this account's own (OWN_FOLDER), answering as each does, with every call
// kept to check what it was given. Its "sealing" is no cipher, only enough to tell a sealed token from the token, and
// the console it was sealed for.
import { windowsTools } from '../credentials.mjs';

export const TOOLS = windowsTools({ SystemRoot: 'C:\\Windows' });
export const ME = { sid: 'S-1-5-21-1004336348-1177238915-682003330-1001' };

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

/**
 * @param {{dpapi?: boolean, others?: string[], foreignOwner?: boolean}} [opts]  `dpapi` false: the seal fails, as with
 *   no logon key (an SSH key's sign-in); `others`: SIDs still allowed on the folder after it is set, besides this
 *   account's and Windows' own; `foreignOwner`: the folder is another account's, which this one cannot take
 */
export function fakeWindows({ dpapi = true, others = [], foreignOwner = false } = {}) {
  const calls = [];
  const owned = new Set();
  const run = (command, args, { input, cwd, env } = {}) => {
    calls.push({ command, args, input, cwd, env });
    if (command !== TOOLS.powershell) return { status: null, stdout: '', stderr: `spawnSync ${command} ENOENT` };
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    if (script.includes('SetAccessControl')) {
      if (!cwd) return { status: 1, stdout: '', stderr: 'no folder' };
      if (foreignOwner) return { status: 3, stdout: 'refused: it could not be made yours (Attempted to perform an unauthorized operation.)\r\n', stderr: '' };
      if (others.length) return { status: 4, stdout: `refused: others may still open it (${others.join(', ')})\r\n`, stderr: '' };
      owned.add(cwd);
      return ok('ok\r\n');
    }
    if (!dpapi) return { status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' };
    const [origin, given] = input.split('\n').map((line) => line.trim());
    if (script.includes('::Unprotect(')) {
      const opened = Buffer.from(given, 'base64').toString('utf8');
      const prefix = `sealed for ${origin}:`;
      return opened.startsWith(prefix) ? ok([...opened.slice(prefix.length)].reverse().join('')) : { status: 1, stdout: '', stderr: 'The parameter is incorrect.' };
    }
    if (script.includes('::Protect(')) return ok(Buffer.from(`sealed for ${origin}:${[...given].reverse().join('')}`).toString('base64'));
    return { status: 1, stdout: '', stderr: 'unknown script' };
  };
  return { run, calls, owned };
}
