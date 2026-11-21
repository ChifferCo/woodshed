// A stand-in for the Windows tools the command line's credentials run (credentials.mjs): Windows PowerShell's DPAPI
// seal and unseal, whoami, and icacls, answering as each does, with every call kept to check what it was given. Its
// "sealing" is no cipher, only enough to tell a sealed token from the token.
import { windowsTools } from '../credentials.mjs';

export const TOOLS = windowsTools({ SystemRoot: 'C:\\Windows' });
export const ME = { name: 'desktop-1\\mia', shown: 'DESKTOP-1\\mia', sid: 'S-1-5-21-1004336348-1177238915-682003330-1001' };

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

/**
 * @param {{dpapi?: boolean, others?: string[]}} [opts]  `dpapi` false: the seal fails, as with no logon key (an SSH
 *   key's sign-in); `others`: who icacls still lists on the folder after it is set, besides this account
 */
export function fakeWindows({ dpapi = true, others = [] } = {}) {
  const calls = [];
  const acls = new Map();
  const run = (command, args, { input } = {}) => {
    calls.push({ command, args, input });
    if (command === TOOLS.whoami) return ok(`"${ME.name}","${ME.sid}"\r\n`);
    if (command === TOOLS.icacls) {
      const [dir, ...change] = args;
      if (change.length) {
        acls.set(dir, [ME.shown, ...others]);
        return ok(`processed file: ${dir}\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
      }
      const holders = acls.get(dir) ?? ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', ME.shown];
      const lines = holders.map((holder, i) => `${i ? ' '.repeat(dir.length + 1) : `${dir} `}${holder}:(OI)(CI)(F)`);
      return ok(`${lines.join('\r\n')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
    }
    if (command === TOOLS.powershell) {
      if (!dpapi) return { status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' };
      const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
      if (script.includes('::Unprotect(')) {
        const opened = Buffer.from(input.trim(), 'base64').toString('utf8');
        return opened.startsWith('sealed:') ? ok([...opened.slice(7)].reverse().join('')) : { status: 1, stdout: '', stderr: 'bad data' };
      }
      if (script.includes('::Protect(')) return ok(Buffer.from(`sealed:${[...input.trim()].reverse().join('')}`).toString('base64'));
    }
    return { status: null, stdout: '', stderr: `spawnSync ${command} ENOENT` };
  };
  return { run, calls, acls };
}
