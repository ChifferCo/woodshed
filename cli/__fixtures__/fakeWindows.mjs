// A stand-in for the Windows tools the command line's credentials run (credentials.mjs): Windows PowerShell's DPAPI
// seal and unseal, whoami, and icacls, answering as each does, with every call kept to check what it was given. Its
// "sealing" is no cipher, only enough to tell a sealed token from the token, and the console it was sealed for.
import { windowsTools } from '../credentials.mjs';

export const TOOLS = windowsTools({ SystemRoot: 'C:\\Windows' });
export const ME = { name: 'desktop-1\\mia', shown: 'DESKTOP-1\\mia', sid: 'S-1-5-21-1004336348-1177238915-682003330-1001' };

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

/**
 * @param {{dpapi?: boolean, others?: string[], foreignOwner?: boolean}} [opts]  `dpapi` false: the seal fails, as with
 *   no logon key (an SSH key's sign-in); `others`: who icacls still lists on the folder after it is set, besides this
 *   account; `foreignOwner`: the folder is another account's, which this one cannot take
 */
export function fakeWindows({ dpapi = true, others = [], foreignOwner = false } = {}) {
  const calls = [];
  const acls = new Map();
  const run = (command, args, { input, cwd } = {}) => {
    calls.push({ command, args, input, cwd });
    if (command === TOOLS.whoami) return ok(`"${ME.name}","${ME.sid}"\r\n`);
    if (command === TOOLS.icacls) {
      // Run in the folder, on `.`, as credentials.mjs does.
      const [target, ...change] = args;
      if (target !== '.' || !cwd) return { status: 2, stdout: '', stderr: `${target}: The system cannot find the file specified.` };
      if (change[0] === '/setowner') {
        return foreignOwner ? { status: 5, stdout: '', stderr: '.: Access is denied.\r\n' } : ok('processed file: .\r\n');
      }
      if (change.length) {
        acls.set(cwd, [ME.shown, ...others]);
        return ok('processed file: .\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n');
      }
      const holders = acls.get(cwd) ?? ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', ME.shown];
      const lines = holders.map((holder, i) => `${i ? '  ' : '. '}${holder}:(OI)(CI)(F)`);
      return ok(`${lines.join('\r\n')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`);
    }
    if (command === TOOLS.powershell) {
      if (!dpapi) return { status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' };
      const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
      const [origin, given] = input.split('\n').map((line) => line.trim());
      if (script.includes('::Unprotect(')) {
        const opened = Buffer.from(given, 'base64').toString('utf8');
        const prefix = `sealed for ${origin}:`;
        return opened.startsWith(prefix) ? ok([...opened.slice(prefix.length)].reverse().join('')) : { status: 1, stdout: '', stderr: 'The parameter is incorrect.' };
      }
      if (script.includes('::Protect(')) return ok(Buffer.from(`sealed for ${origin}:${[...given].reverse().join('')}`).toString('base64'));
    }
    return { status: null, stdout: '', stderr: `spawnSync ${command} ENOENT` };
  };
  return { run, calls, acls };
}
