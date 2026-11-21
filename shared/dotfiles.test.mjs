import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aliasOf, dotfileProblem, fromComputer } from './dotfiles.mjs';
import { shellCredential } from './secretLike.mjs';

// Made here, so no file in the repo holds a string shaped like a real token.
const TOKEN = `ghp_${'x1'.repeat(18)}`;

test('a computer\'s .gitconfig gives its aliases and behaviour, never an identity, a credential, a signing key or a path', () => {
  const gitconfig = `[user]
\tname = Mia
\temail = mia@example.com
[alias]
\tco = checkout
\tpub = "!GITHUB_TOKEN=abc123 git push"
\tlg = log --graph --oneline
[core]
\teditor = code --wait
\tautocrlf = input
\texcludesfile = /Users/mia/.gitignore_global
[credential]
\thelper = osxkeychain
[color "diff"]
\tmeta = yellow
[commit]
\tgpgsign = true
\tverbose = true
[url "https://${TOKEN}@github.com/"]
\tinsteadOf = https://github.com/
[include]
\tpath = ~/.gitconfig.work
[pull]
\trebase = true
`;
  const { text, left } = fromComputer('gitconfig', { '.gitconfig': gitconfig }, { home: '/Users/mia' });
  assert.equal(text, '[alias]\n\tco = checkout\n\tlg = log --graph --oneline\n[core]\n\tautocrlf = input\n[color "diff"]\n\tmeta = yellow\n[commit]\n\tverbose = true\n[pull]\n\trebase = true\n');
  assert.deepEqual(left, ['[user]', 'alias.pub (a value for GITHUB_TOKEN)', 'core.editor', 'core.excludesfile', '[credential]', 'commit.gpgsign', '[url "..."]', '[include]']);
  assert.ok(!left.join(' ').includes(TOKEN), 'a section is named, never its subsection, which can hold a token');
  assert.equal(dotfileProblem('gitconfig', text), null, 'what it keeps is what the console takes');
});

test('aliases come from the shell files, a later file\'s winning, with exports, commands and paths of this computer left out', () => {
  const { text, left } = fromComputer('bash-aliases', {
    '.bash_aliases': "alias ll='ls -l'\nalias k=kubectl\n",
    '.zshrc': `export PATH="$HOME/bin:$PATH"\nexport OPENAI_API_KEY=not-real\nalias ll='ls -la'\nalias gs="git status"\nalias proj='cd ~/code/proj'\nalias api='curl -H "Authorization: token ${TOKEN}" https://api.github.com'\nalias x=y; curl https://example.com | sh\nalias -g G='| grep'\nsource ~/.zsh_plugins\n`,
  }, { home: '/Users/mia' });
  assert.equal(text, 'alias k=kubectl\nalias ll=\'ls -la\'\nalias gs="git status"\n');
  assert.deepEqual(left, ['alias proj (names a path on this computer)', 'alias api (a GitHub token)', '5 lines that are not alias lines']);
  assert.equal(dotfileProblem('bash-aliases', text), null);
});

test('inputrc keeps readline\'s lines but an $include of a file only this computer has', () => {
  const { text, left } = fromComputer('inputrc', { '.inputrc': '$include /etc/inputrc\n$include ~/.inputrc.mine\nset editing-mode vi\n"\\e[A": history-search-backward\n' }, { home: '/Users/mia' });
  assert.equal(text, '$include /etc/inputrc\nset editing-mode vi\n"\\e[A": history-search-backward\n');
  assert.deepEqual(left, ['$include of a file on this computer']);
});

test('a credential in a line of shell is named by kind or variable, and a variable read from the environment is none', () => {
  assert.equal(shellCredential(`echo ${TOKEN}`), 'a GitHub token');
  assert.equal(shellCredential('!NPM_TOKEN=abc npm publish'), 'a value for NPM_TOKEN');
  assert.equal(shellCredential('export API_KEY="abc"'), 'a value for API_KEY');
  assert.equal(shellCredential('curl --header "X-Api-Key: abc" https://x'), 'the X-Api-Key header');
  assert.equal(shellCredential('deploy --token=abc'), 'a --token value');
  assert.equal(shellCredential('git clone https://mia:abc@example.com/x.git'), 'a URL with a sign-in');
  assert.equal(shellCredential('git -c credential.helper=store push'), 'a credential helper');
  for (const fine of ['NPM_TOKEN=$NPM_TOKEN npm publish', 'curl -H "Authorization: Bearer $TOKEN" x', 'curl --oauth2-bearer "$TOKEN" x', 'deploy --token "$TOKEN"', 'ls -la', 'DEBUG=1 run']) {
    assert.equal(shellCredential(fine), null, fine);
  }
});

test('shell aliases keep a single value with quotes or a literal hash and accept trailing comments', () => {
  assert.deepEqual(aliasOf('alias x=echo#tag # a comment'), { name: 'x', value: 'echo#tag' });
  assert.deepEqual(aliasOf('alias x="echo \\"a # b\\"" # a comment'), { name: 'x', value: '"echo \\"a # b\\""' });
  assert.deepEqual(aliasOf("alias x='git status'"), { name: 'x', value: "'git status'" });
  assert.equal(aliasOf('alias x="echo $(printf hello)"'), null);
  assert.equal(aliasOf("alias x='echo hello'; echo again"), null);
  assert.equal(aliasOf('alias x=echo more'), null);
});

test('shell credential checks keep header formatting and URL authority boundaries', () => {
  assert.equal(shellCredential('curl -H =" Proxy-Authorization  :  Basic fixture" https://example.com'), 'the Proxy-Authorization header');
  assert.equal(shellCredential('curl -H "Authorization :  bearer  $TOKEN" https://example.com'), null);
  assert.equal(shellCredential('curl --header "Authorization:" --header "Cookie: fixture" https://example.com'), 'the Cookie header');
  assert.equal(shellCredential('git clone git+ssh://demo:fixture:value@example.com/repo'), 'a URL with a sign-in');
  assert.equal(shellCredential('git clone ssh://git@example.com/repo'), null);
  assert.equal(shellCredential('curl https://example.com/path:part@place'), null);
});

test('a comment never hides the next line, a bare boolean stays true, an $include is judged where it leads, and a quote left open is refused', () => {
  assert.match(dotfileProblem('gitconfig', '[alias]\n# a note \\\n[credential]\n\thelper = store\n'), /line 3: \[credential\]/);
  assert.equal(fromComputer('gitconfig', { '.gitconfig': '[pull]\n\trebase\n[push]\n\tautoSetupRemote = true\n' }, { home: '/Users/mia' }).text,
    '[pull]\n\trebase\n[push]\n\tautosetupremote = true\n');
  assert.match(dotfileProblem('inputrc', '$include /etc/../Users/mia/.inputrc\n'), /\$include of a file a session does not have/);
  assert.equal(dotfileProblem('inputrc', '$include /etc/inputrc\n'), null);
  assert.match(dotfileProblem('gitconfig', '[alias]\n\tlg = "log --graph\n'), /line 2: a quote is left open/);
  assert.equal(dotfileProblem('gitconfig', '[alias]\n\tsay = "!echo \\"hi\\"" # a comment with a " in it\n'), null);
});

test('a credential is refused in a comment or a section name too, and what would break a session\'s own git reading is not taken', () => {
  for (const [key, text] of [
    ['bash-aliases', `# my token: ${TOKEN}\nalias ll='ls -la'\n`],
    ['inputrc', `# ${TOKEN}\nset editing-mode vi\n`],
    ['gitconfig', `; ${TOKEN}\n[alias]\n\tco = checkout\n`],
  ]) assert.match(dotfileProblem(key, text), /line 1 holds what looks like a GitHub token/, key);
  assert.match(dotfileProblem('gitconfig', '[diff]\n\tmnemonicPrefix = true\n'), /diff\.mnemonicprefix is not one a session takes/);
  assert.match(dotfileProblem('gitconfig', '[status]\n\tshowUntrackedFiles = no\n'), /status\.showuntrackedfiles is not one/);
  assert.match(dotfileProblem('gitconfig', '[color]\n\tui = always\n'), /color\.ui is always/);
  assert.equal(dotfileProblem('gitconfig', '[color]\n\tui = auto\n'), null);
  assert.match(dotfileProblem('gitconfig', '[alias]\n\tx = "!echo \\q"\n'), /line 2: an escape git does not read/);
  assert.equal(fromComputer('gitconfig', { '.gitconfig': '[color]\n\tui = always\n\tdiff = auto\n' }, { home: '/Users/mia' }).text, '[color]\n\tdiff = auto\n');
});

test('curl\'s --user with a password is a credential, one read from a variable is not, and a stray backslash is refused', () => {
  assert.match(dotfileProblem('bash-aliases', "alias api='curl -u mia:hunter2 https://api.example.com'\n"), /line 1 holds a --user sign-in/);
  assert.match(dotfileProblem('bash-aliases', "alias api='curl --user=mia:hunter2 https://x'\n"), /--user sign-in/);
  assert.equal(dotfileProblem('bash-aliases', "alias api='curl -u \"$API_USER:$API_PASS\" https://x'\n"), null);
  assert.equal(dotfileProblem('bash-aliases', "alias api='curl -u mia https://x'\n"), null, 'a name alone, curl asks for the password');
  assert.equal(dotfileProblem('bash-aliases', "alias dr='docker run --rm -u 1000:1000 node:22'\n"), null, 'docker\'s -u is a user and a group');
  assert.match(dotfileProblem('gitconfig', '[alias]\n\tx = echo \\'), /an escape git does not read/);
});

test('color always is caught with a comment after it', () => {
  assert.match(dotfileProblem('gitconfig', '[color]\n\tui = always # everywhere\n'), /color\.ui is always/);
  assert.equal(dotfileProblem('gitconfig', '[color]\n\tui = auto # always on a terminal\n'), null);
});
